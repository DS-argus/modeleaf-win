use std::collections::{BTreeMap, BTreeSet};
use std::fs::{File, OpenOptions};
use std::io::{BufWriter, Write};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread;
use std::time::{Duration, Instant};

use clap::Parser;
use serde::Serialize;
use windows::core::Error as WindowsError;
use windows::Win32::Foundation::{CloseHandle, INVALID_HANDLE_VALUE};
use windows::Win32::System::Diagnostics::ToolHelp::{
    CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W, TH32CS_SNAPPROCESS,
};
use windows::Win32::System::ProcessStatus::{GetProcessMemoryInfo, PROCESS_MEMORY_COUNTERS_EX};
use windows::Win32::System::Threading::{OpenProcess, PROCESS_QUERY_INFORMATION, PROCESS_VM_READ};

const SCHEMA: &str = "modeleaf.phase0.process-tree.v1";

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ProcessRow {
    pub pid: u32,
    pub parent_pid: u32,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MemoryRow {
    pub pid: u32,
    pub parent_pid: u32,
    pub private_bytes: u64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum RootTransition {
    Sample,
    MissingBeforeSample,
    EndAfterSample,
}

pub fn root_transition(root_present: bool, successful_samples: u64) -> RootTransition {
    if root_present {
        RootTransition::Sample
    } else if successful_samples == 0 {
        RootTransition::MissingBeforeSample
    } else {
        RootTransition::EndAfterSample
    }
}

pub fn descendant_closure(root_pid: u32, rows: &[ProcessRow]) -> Vec<ProcessRow> {
    let by_parent = rows
        .iter()
        .fold(BTreeMap::<u32, Vec<ProcessRow>>::new(), |mut map, row| {
            map.entry(row.parent_pid).or_default().push(row.clone());
            map
        });
    let mut included = BTreeSet::from([root_pid]);
    let mut pending = vec![root_pid];

    while let Some(parent_pid) = pending.pop() {
        if let Some(children) = by_parent.get(&parent_pid) {
            for child in children {
                if included.insert(child.pid) {
                    pending.push(child.pid);
                }
            }
        }
    }

    let mut result: Vec<_> = rows
        .iter()
        .filter(|row| included.contains(&row.pid))
        .cloned()
        .collect();
    result.sort_by_key(|row| row.pid);
    result
}

pub fn checked_total_private_bytes(rows: &[MemoryRow]) -> Result<u64, &'static str> {
    rows.iter().try_fold(0_u64, |total, row| {
        total
            .checked_add(row.private_bytes)
            .ok_or("private memory total overflowed u64")
    })
}

#[derive(Serialize)]
struct JsonProcessRow {
    pid: u32,
    parent_pid: u32,
    private_bytes: u64,
}

#[derive(Serialize)]
struct Sample {
    schema: &'static str,
    sample_index: u64,
    elapsed_ms: u64,
    root_pid: u32,
    processes: Vec<JsonProcessRow>,
    total_private_bytes: u64,
    inaccessible_pids: Vec<u32>,
    outcome: &'static str,
}

pub fn sample_json(
    sample_index: u64,
    elapsed_ms: u64,
    root_pid: u32,
    mut rows: Vec<MemoryRow>,
    mut inaccessible_pids: Vec<u32>,
) -> Result<String, &'static str> {
    rows.sort_by_key(|row| row.pid);
    inaccessible_pids.sort_unstable();
    inaccessible_pids.dedup();
    let total_private_bytes = checked_total_private_bytes(&rows)?;
    let processes = rows
        .into_iter()
        .map(|row| JsonProcessRow {
            pid: row.pid,
            parent_pid: row.parent_pid,
            private_bytes: row.private_bytes,
        })
        .collect();
    serde_json::to_string(&Sample {
        schema: SCHEMA,
        sample_index,
        elapsed_ms,
        root_pid,
        processes,
        total_private_bytes,
        inaccessible_pids,
        outcome: "ok",
    })
    .map_err(|_| "could not serialize sample")
}

#[derive(Debug, Parser)]
#[command(name = "process-tree-metrics", disable_version_flag = true)]
pub struct Cli {
    #[arg(long)]
    pub root_pid: u32,
    #[arg(long, default_value_t = 100, value_parser = clap::value_parser!(u64).range(50..=1000))]
    pub interval_ms: u64,
    #[arg(long)]
    pub output: PathBuf,
    #[arg(long)]
    pub duration_ms: Option<u64>,
}

fn snapshot_processes() -> Result<Vec<ProcessRow>, WindowsError> {
    unsafe {
        let snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0)?;
        if snapshot == INVALID_HANDLE_VALUE {
            return Err(WindowsError::from_win32());
        }
        let result = (|| {
            let mut entry = PROCESSENTRY32W {
                dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32,
                ..Default::default()
            };
            let mut rows = Vec::new();
            if Process32FirstW(snapshot, &mut entry).is_ok() {
                loop {
                    rows.push(ProcessRow {
                        pid: entry.th32ProcessID,
                        parent_pid: entry.th32ParentProcessID,
                    });
                    entry.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as u32;
                    if Process32NextW(snapshot, &mut entry).is_err() {
                        break;
                    }
                }
            }
            Ok(rows)
        })();
        let _ = CloseHandle(snapshot);
        result
    }
}

fn private_bytes(pid: u32) -> Result<u64, WindowsError> {
    unsafe {
        let process = OpenProcess(PROCESS_QUERY_INFORMATION | PROCESS_VM_READ, false, pid)?;
        let result = (|| {
            let mut counters = PROCESS_MEMORY_COUNTERS_EX {
                cb: std::mem::size_of::<PROCESS_MEMORY_COUNTERS_EX>() as u32,
                ..Default::default()
            };
            GetProcessMemoryInfo(
                process,
                &mut counters as *mut PROCESS_MEMORY_COUNTERS_EX as *mut _,
                std::mem::size_of::<PROCESS_MEMORY_COUNTERS_EX>() as u32,
            )?;
            Ok(counters.PrivateUsage as u64)
        })();
        let _ = CloseHandle(process);
        result
    }
}

fn create_output(path: &PathBuf) -> Result<BufWriter<File>, String> {
    OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
        .map(BufWriter::new)
        .map_err(|error| format!("refusing to create output file: {error}"))
}

pub fn run(cli: Cli) -> Result<(), String> {
    let mut output = create_output(&cli.output)?;
    let interrupted = Arc::new(AtomicBool::new(false));
    let signal = Arc::clone(&interrupted);
    ctrlc::set_handler(move || signal.store(true, Ordering::SeqCst))
        .map_err(|error| format!("could not install Ctrl+C handler: {error}"))?;

    let start = Instant::now();
    let interval = Duration::from_millis(cli.interval_ms);
    let mut next_sample = start;
    let mut sample_index = 0_u64;

    while !interrupted.load(Ordering::SeqCst) {
        let elapsed = start.elapsed();
        if cli
            .duration_ms
            .is_some_and(|duration| elapsed >= Duration::from_millis(duration))
        {
            break;
        }

        let snapshot =
            snapshot_processes().map_err(|error| format!("process snapshot failed: {error}"))?;
        let root_present = snapshot.iter().any(|row| row.pid == cli.root_pid);
        match root_transition(root_present, sample_index) {
            RootTransition::MissingBeforeSample => {
                return Err("root process was not found".to_owned())
            }
            RootTransition::EndAfterSample => break,
            RootTransition::Sample => {}
        }

        let mut memory_rows = Vec::new();
        let mut inaccessible_pids = Vec::new();
        for row in descendant_closure(cli.root_pid, &snapshot) {
            match private_bytes(row.pid) {
                Ok(private_bytes) => memory_rows.push(MemoryRow {
                    pid: row.pid,
                    parent_pid: row.parent_pid,
                    private_bytes,
                }),
                Err(_) => inaccessible_pids.push(row.pid),
            }
        }
        let elapsed_ms = u64::try_from(elapsed.as_millis()).unwrap_or(u64::MAX);
        let line = sample_json(
            sample_index,
            elapsed_ms,
            cli.root_pid,
            memory_rows,
            inaccessible_pids,
        )
        .map_err(str::to_owned)?;
        output
            .write_all(line.as_bytes())
            .and_then(|_| output.write_all(b"\n"))
            .and_then(|_| output.flush())
            .map_err(|error| format!("could not write output: {error}"))?;
        sample_index = sample_index
            .checked_add(1)
            .ok_or("sample index overflowed u64")?;

        next_sample += interval;
        let now = Instant::now();
        if next_sample > now {
            thread::sleep(next_sample.duration_since(now));
        } else {
            next_sample = now;
        }
    }
    Ok(())
}
