//! Show what the log redactor changes: lines on stdin, changed ones on stdout as
//! `- before` / `+ after` (a tuning aid; never run it on output you will share).
use std::io::BufRead;

fn main() {
    let mut pem = false;
    for l in std::io::stdin().lock().lines().map_while(Result::ok) {
        let (r, p) = switchyard::logs::redact_line(&l, pem);
        pem = p;
        if r != l {
            println!("- {}\n+ {}", &l[..l.len().min(200)], &r[..r.len().min(200)]);
        }
    }
}
