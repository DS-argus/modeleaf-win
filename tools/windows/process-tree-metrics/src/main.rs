use clap::Parser;
use process_tree_metrics::{run, Cli};

fn main() {
    let cli = Cli::parse();
    if let Err(error) = run(cli) {
        eprintln!("process-tree-metrics: {error}");
        std::process::exit(1);
    }
}
