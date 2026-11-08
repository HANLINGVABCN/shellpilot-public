#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.iter().any(|a| a == "--mcp" || a == "mcp") {
        shellpilot_server::run_mcp_cli();
        return;
    }
    shellpilot_app_lib::run()
}
