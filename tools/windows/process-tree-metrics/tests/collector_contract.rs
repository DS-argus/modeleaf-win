use process_tree_metrics as collector;

use clap::Parser;
use collector::{
    checked_total_private_bytes, descendant_closure, root_transition, sample_json, MemoryRow,
    ProcessRow, RootTransition,
};

#[test]
fn parses_required_arguments_and_default_interval() {
    let cli = collector::Cli::try_parse_from([
        "process-tree-metrics",
        "--root-pid",
        "42",
        "--output",
        "evidence.jsonl",
    ])
    .expect("valid arguments");

    assert_eq!(cli.root_pid, 42);
    assert_eq!(cli.interval_ms, 100);
    assert_eq!(cli.output.to_string_lossy(), "evidence.jsonl");
    assert_eq!(cli.duration_ms, None);
    assert!(collector::Cli::try_parse_from([
        "process-tree-metrics",
        "--root-pid",
        "42",
        "--interval-ms",
        "49",
        "--output",
        "evidence.jsonl",
    ])
    .is_err());
}

#[test]
fn finds_recursive_descendants_and_sorts_them() {
    let rows = [
        ProcessRow {
            pid: 30,
            parent_pid: 20,
        },
        ProcessRow {
            pid: 99,
            parent_pid: 1,
        },
        ProcessRow {
            pid: 10,
            parent_pid: 0,
        },
        ProcessRow {
            pid: 20,
            parent_pid: 10,
        },
        ProcessRow {
            pid: 40,
            parent_pid: 30,
        },
    ];

    let closure = descendant_closure(10, &rows);
    assert_eq!(
        closure,
        vec![
            ProcessRow {
                pid: 10,
                parent_pid: 0
            },
            ProcessRow {
                pid: 20,
                parent_pid: 10
            },
            ProcessRow {
                pid: 30,
                parent_pid: 20
            },
            ProcessRow {
                pid: 40,
                parent_pid: 30
            },
        ]
    );
}

#[test]
fn totals_are_checked() {
    assert_eq!(
        checked_total_private_bytes(&[
            MemoryRow {
                pid: 1,
                parent_pid: 0,
                private_bytes: 7
            },
            MemoryRow {
                pid: 2,
                parent_pid: 1,
                private_bytes: 11
            },
        ]),
        Ok(18)
    );
    assert!(checked_total_private_bytes(&[
        MemoryRow {
            pid: 1,
            parent_pid: 0,
            private_bytes: u64::MAX
        },
        MemoryRow {
            pid: 2,
            parent_pid: 1,
            private_bytes: 1
        },
    ])
    .is_err());
}

#[test]
fn serializes_a_deterministic_sorted_strict_shape() {
    let json = sample_json(
        3,
        250,
        10,
        vec![
            MemoryRow {
                pid: 20,
                parent_pid: 10,
                private_bytes: 11,
            },
            MemoryRow {
                pid: 10,
                parent_pid: 0,
                private_bytes: 7,
            },
        ],
        vec![20, 10, 20],
    )
    .expect("serializable sample");

    assert_eq!(json, "{\"schema\":\"modeleaf.phase0.process-tree.v1\",\"sample_index\":3,\"elapsed_ms\":250,\"root_pid\":10,\"processes\":[{\"pid\":10,\"parent_pid\":0,\"private_bytes\":7},{\"pid\":20,\"parent_pid\":10,\"private_bytes\":11}],\"total_private_bytes\":18,\"inaccessible_pids\":[10,20],\"outcome\":\"ok\"}");
}

#[test]
fn distinguishes_missing_root_before_and_after_sampling() {
    assert_eq!(
        root_transition(false, 0),
        RootTransition::MissingBeforeSample
    );
    assert_eq!(root_transition(false, 1), RootTransition::EndAfterSample);
    assert_eq!(root_transition(true, 0), RootTransition::Sample);
}
