"""Diagnóstico (temporário): gera com o gerador da branch fix/agua-do-mar alguns grupos e monta folhas."""
import os, subprocess, sys
from PIL import Image
G = {'jeolla': [(48, 271), (48, 272), (49, 271), (49, 272)], 'rio': [(100, 120), (100, 121), (101, 120), (101, 121)]}
todos = ';'.join(f'{r},{c}' for v in G.values() for r, c in v)
subprocess.run([sys.executable, 'blocos/gerar_s2.py', '--saida', '/tmp/s2', '--grupos', todos, '--processos', '4'], check=True)
os.makedirs('saida3', exist_ok=True)
for nome, gs in G.items():
    r0 = min(r for r, _ in gs) * 4; c0 = min(c for _, c in gs) * 4
    out = Image.new('RGB', (8 * 128, 8 * 128), (255, 0, 255))
    for i in range(8):
        for j in range(8):
            p = f'/tmp/s2/blocos/w10/{r0 + i}/{c0 + j}.webp'
            if os.path.exists(p):
                out.paste(Image.open(p).convert('RGB').resize((128, 128)), (j * 128, i * 128))
    out.save(f'saida3/{nome}_novo.jpg', quality=85)
