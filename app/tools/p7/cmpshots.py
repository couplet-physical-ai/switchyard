#!/usr/bin/env python3
"""p7: compare the drives' window pictures, step by step: <dirA> <dirB> [diffdir]. Prints differing px and bbox per step."""
import sys, os
from PIL import Image, ImageChops
a, b = sys.argv[1], sys.argv[2]
out = sys.argv[3] if len(sys.argv) > 3 else None
if out: os.makedirs(out, exist_ok=True)
for f in sorted(x for x in os.listdir(a) if x.endswith('.png')):
    pb = os.path.join(b, f)
    if not os.path.exists(pb): print(f'{f}: missing in {b}'); continue
    ia = Image.open(os.path.join(a, f)).convert('RGB'); ib = Image.open(pb).convert('RGB')
    if ia.size != ib.size: print(f'{f}: size differs {ia.size} {ib.size}'); continue
    d = ImageChops.difference(ia, ib).convert('L')
    m = d.point(lambda v: 255 if v > 0 else 0)
    n = sum(1 for v in m.getdata() if v)
    big = sum(1 for v in d.getdata() if v > 64)
    print(f'{f}: {n} of {ia.size[0]*ia.size[1]} px differ ({big} by >64), bbox {m.getbbox()}')
    if out and n: m.save(os.path.join(out, 'diff-' + f))
