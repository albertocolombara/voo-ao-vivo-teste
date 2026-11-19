import json,glob,statistics as st,itertools
rows=[json.loads(l) for f in sorted(glob.glob('data/*.ndjson')) for l in open(f) if l.strip()]
L=[r for r in rows if r['k']=='watch' and r.get('eta_ver')==2 and r['status']=='landed' and r.get('first_gs')]
for r in L: r['actual']=(r['actual_land']-r['first_ts'])/60000
L.sort(key=lambda r:r['first_ts']); half=len(L)//2; train,test=L[:half],L[half:]
BK=[(25,60,'25–59'),(60,90,'60–89'),(90,180,'1h30–3h'),(180,360,'3–6h'),(360,9e9,'6h+')]
def bucket(r):
  for lo,hi,lab in BK:
    if lo<=r['actual']<hi: return lab
def eta(r,k,S,c,w,kmin):
  rem,gs,alt=r['first_rem_km'],r['first_gs'],r['first_alt']
  cruising=isinstance(alt,(int,float)) and alt>=25000 and gs>=380
  if rem>300 and not cruising: spd=max(gs,S)
  elif cruising and rem>300: spd=w*gs+(1-w)*S
  else: spd=gs
  kk=k if rem>kmin else 1.0
  return kk*rem/(spd*1.852)*60+c
def score(D,p):
  by={}
  for r in D: by.setdefault(bucket(r),[]).append(r['actual']-eta(r,*p))
  # erro relativo: mediana |erro| / duração típica da faixa, média entre faixas com n>=10
  meds=[st.median([abs(x) for x in v])/st.median([r['actual'] for r in D if bucket(r)==b]) for b,v in by.items() if b and len(v)>=10]
  return st.mean(meds)
grid=list(itertools.product([1.0,1.02,1.04,1.06,1.08,1.10],[440,450,460,470,480,500],[5,8,11,14,17],[1.0,0.75,0.5],[300,800,1500]))
best=sorted(grid,key=lambda p:score(train,p))[:5]
base=(1.0,470,8,1.0,300)
print('n treino',len(train),'teste',len(test))
print('v2 atual  treino %.4f teste %.4f'%(score(train,base),score(test,base)))
for p in best: print(p,'treino %.4f teste %.4f'%(score(train,p),score(test,p)))
def report(D,p,name):
  print('\n'+name, p)
  for lo,hi,lab in BK:
    e=[r['actual']-eta(r,*p) for r in D if bucket(r)==lab]
    if e: a=sorted(abs(x) for x in e); print(f" {lab:8} n={len(e):3} típico={st.median(a):5.1f} viés={st.median(e):+6.1f} ±10={round(100*sum(x<=10 for x in a)/len(a)):3}% p90={a[int(.9*(len(a)-1))]:6.1f}")
report(test,base,'TESTE — v2 atual'); report(test,best[0],'TESTE — melhor ajuste')
report(L,base,'TODOS — v2 atual'); report(L,best[0],'TODOS — melhor ajuste')

print('\n===== ajuste por distância restante =====')
def eta2(r,P):
  rem=r['first_rem_km']
  if rem<=300: return rem/(r['first_gs']*1.852)*60+8
  p=P['mid'] if rem<=2500 else P['long']
  return eta(r,p[0],p[1],p[2],p[3],0)
cls=lambda r: 'curto' if r['first_rem_km']<=300 else ('mid' if r['first_rem_km']<=2500 else 'long')
def obj(D,p):
  e=[abs(r['actual']-eta(r,p[0],p[1],p[2],p[3],0))/r['actual'] for r in D]
  return st.median(e)+0.5*abs(st.median([(r['actual']-eta(r,p[0],p[1],p[2],p[3],0))/r['actual'] for r in D]))
g=list(itertools.product([0.98,1.0,1.02,1.04,1.06,1.08,1.10],[430,440,450,460,470,480,490,500],[5,8,11,14],[1.0,0.75,0.5]))
P={}
for c in ['mid','long']:
  tr=[r for r in train if cls(r)==c]; te=[r for r in test if cls(r)==c]
  bp=min(g,key=lambda p:obj(tr,p)); P[c]=bp
  print(c,'n',len(tr),len(te),'melhor',bp,'treino %.4f teste %.4f | v2 atual treino %.4f teste %.4f'%(obj(tr,bp),obj(te,bp),obj(tr,(1.0,470,8,1.0)),obj(te,(1.0,470,8,1.0))))
def report2(D,name):
  print('\n'+name)
  for lo,hi,lab in BK:
    S=[r for r in D if bucket(r)==lab]
    if not S: continue
    for nm,f in [('v2',lambda r: eta(r,1.0,470,8,1.0,300)),('v3',lambda r: eta2(r,P))]:
      e=[r['actual']-f(r) for r in S]; a=sorted(abs(x) for x in e)
      print(f" {lab:8} {nm} n={len(e):3} típico={st.median(a):5.1f} viés={st.median(e):+6.1f} ±10={round(100*sum(x<=10 for x in a)/len(a)):3}% ±15={round(100*sum(x<=15 for x in a)/len(a)):3}% p90={a[int(.9*(len(a)-1))]:6.1f} rel={100*st.median([abs(x)/r['actual'] for x,r in zip(e,S)]):4.1f}%")
report2(test,'TESTE (segunda metade, não usada no ajuste)')

print('\n===== v3 final: v2 até 2.500 km; longos com ajuste =====')
LONGP=P['long']
def eta3(r):
  if r['first_rem_km']<=2500: return eta(r,1.0,470,8,1.0,300)
  return eta(r,LONGP[0],LONGP[1],LONGP[2],LONGP[3],0)
for D,name in [(test,'TESTE'),(L,'TODOS')]:
  print(name)
  for lo,hi,lab in BK:
    S=[r for r in D if bucket(r)==lab]
    if not S: continue
    for nm,f in [('v2',lambda r: eta(r,1.0,470,8,1.0,300)),('v3',eta3)]:
      e=[r['actual']-f(r) for r in S]; a=sorted(abs(x) for x in e)
      print(f" {lab:8} {nm} n={len(e):3} típico={st.median(a):5.1f} viés={st.median(e):+6.1f} ±10={round(100*sum(x<=10 for x in a)/len(a)):3}% ±15={round(100*sum(x<=15 for x in a)/len(a)):3}% p90={a[int(.9*(len(a)-1))]:6.1f} rel={100*st.median([abs(x)/r['actual'] for x,r in zip(e,S)]):4.1f}%")
print('parâmetros longos',LONGP)
