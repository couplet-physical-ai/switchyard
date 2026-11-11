//! Debug tool: classify a step log read from stdin (one line per line) and print the
//! failure signature, the decisive line, and every line that classifies on its own.
//! `cargo run --example classify -- <workflow> <step> [exit_code] < log.txt`

use std::io::Read;

fn main() {
    let a: Vec<String> = std::env::args().collect();
    let wf = a.get(1).cloned().unwrap_or_default();
    let step = a.get(2).cloned().unwrap_or_default();
    let exit = a.get(3).and_then(|x| x.parse().ok());
    let mut s = String::new();
    std::io::stdin().read_to_string(&mut s).unwrap();
    let lines: Vec<String> = s.lines().map(str::to_string).collect();
    let (sig, idx) = switchyard::signature::extract_at(&wf, &step, exit, &lines);
    println!("signature: {sig:?}");
    if let Some(i) = idx {
        println!("decisive [{i}]: {}", lines[i]);
    }
    for (i, l) in lines.iter().enumerate() {
        let (one, _) = switchyard::signature::extract_at(&wf, &step, exit, std::slice::from_ref(l));
        if let Some(line) = one.line {
            println!("  [{i}] {:?}: {line}", one.class);
        }
    }
}
