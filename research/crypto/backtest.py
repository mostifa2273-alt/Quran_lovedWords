from __future__ import annotations
import io,json,zipfile
from pathlib import Path
from itertools import product
import requests,numpy as np,pandas as pd
import matplotlib.pyplot as plt

OUT=Path('research/crypto/results'); OUT.mkdir(parents=True,exist_ok=True)
BASE='https://data.binance.vision/data/futures/um/monthly/klines/BTCUSDT/1h'
COSTS=[.002,.003,.004,.005]

def load():
    hs=['open_time','open','high','low','close','volume','close_time','quote_volume','trades','taker_base','taker_quote','ignore']
    frames=[]; end=pd.Timestamp.utcnow().to_period('M')
    for p in pd.period_range('2020-01',end,freq='M'):
        ym=str(p); u=f'{BASE}/BTCUSDT-1h-{ym}.zip'
        r=requests.get(u,timeout=45)
        if r.status_code==404: continue
        r.raise_for_status()
        with zipfile.ZipFile(io.BytesIO(r.content)) as z: a=pd.read_csv(z.open(z.namelist()[0]),header=None)
        a=a.iloc[:,:12]; a.columns=hs; frames.append(a); print('downloaded',ym,len(a))
    if not frames: raise RuntimeError('No Binance data downloaded')
    d=pd.concat(frames,ignore_index=True)
    d['time']=pd.to_datetime(d.open_time,unit='ms',utc=True)
    for c in ['open','high','low','close','volume']: d[c]=pd.to_numeric(d[c],errors='coerce')
    return d[['time','open','high','low','close','volume']].dropna().drop_duplicates('time').sort_values('time').set_index('time')

def feat(d):
    x=d.copy(); pc=x.close.shift(); tr=pd.concat([x.high-x.low,(x.high-pc).abs(),(x.low-pc).abs()],axis=1).max(axis=1)
    x['atr']=tr.ewm(alpha=1/14,adjust=False).mean(); up=x.high.diff(); dn=-x.low.diff()
    plus=pd.Series(np.where((up>dn)&(up>0),up,0.),index=x.index); minus=pd.Series(np.where((dn>up)&(dn>0),dn,0.),index=x.index)
    atr=tr.ewm(alpha=1/14,adjust=False).mean(); pdi=100*plus.ewm(alpha=1/14,adjust=False).mean()/atr; mdi=100*minus.ewm(alpha=1/14,adjust=False).mean()/atr
    x['adx']=(100*(pdi-mdi).abs()/(pdi+mdi).replace(0,np.nan)).ewm(alpha=1/14,adjust=False).mean()
    x['ema20']=x.close.ewm(span=20,adjust=False).mean(); x['ema100']=x.close.ewm(span=100,adjust=False).mean(); x['ema200d']=x.close.ewm(span=4800,adjust=False).mean()
    for n in [72,168]: x[f'hi{n}']=x.high.shift().rolling(n).max(); x[f'lo{n}']=x.low.shift().rolling(n).min()
    x['exit_hi']=x.high.shift().rolling(48).max(); x['exit_lo']=x.low.shift().rolling(48).min(); x['mean']=x.close.rolling(168).mean(); x['std']=x.close.rolling(168).std(); x['z']=(x.close-x['mean'])/x['std']
    x['rv24']=x.close.pct_change().rolling(24).std(); x['rv168']=x.close.pct_change().rolling(168).std(); x['rv95']=x.rv24.rolling(2160).quantile(.95); x['vmed']=x.volume.rolling(720).median()
    return x.dropna()

def signals(x,z=2.25,adx_r=18):
    s=pd.Series(0,index=x.index,dtype='int8'); e=pd.Series('cash',index=x.index,dtype='object')
    tu=(x.close>x.ema200d)&(x.ema20>x.ema100)&(x.adx>=20); td=(x.close<x.ema200d)&(x.ema20<x.ema100)&(x.adx>=20)
    s[tu&(x.close>x.hi72)]=1; s[td&(x.close<x.lo72)]=-1; e[s!=0]='trend'
    vr=(x.rv24>x.rv168)&(x.rv24<x.rv95)&(x.volume>x.vmed)
    m=(s==0)&vr&(x.close>x.hi168); s[m]=1; e[m]='breakout'; m=(s==0)&vr&(x.close<x.lo168); s[m]=-1; e[m]='breakout'
    m=(s==0)&(x.adx<adx_r)&(x.z<-z); s[m]=1; e[m]='mean'; m=(s==0)&(x.adx<adx_r)&(x.z>z); s[m]=-1; e[m]='mean'
    return s,e

def bt(x,z,adx_r,trail,cost):
    s,e=signals(x,z,adx_r); out=[]; pos=0
    for i in range(1,len(x)):
        p=x.iloc[i-1]; r=x.iloc[i]; t=x.index[i]
        if pos==0 and s.iloc[i-1]: pos=int(s.iloc[i-1]); entry=float(r.open); et=t; who=e.iloc[i-1]; stop=entry-pos*trail*float(p.atr); continue
        if pos==0: continue
        stop=max(stop,float(p.close-trail*p.atr)) if pos==1 else min(stop,float(p.close+trail*p.atr)); xp=None; why=None
        if pos==1 and r.low<=stop: xp=stop; why='stop'
        elif pos==-1 and r.high>=stop: xp=stop; why='stop'
        elif who=='trend' and ((pos==1 and p.close<p.exit_lo) or (pos==-1 and p.close>p.exit_hi)): xp=float(r.open); why='channel'
        elif who=='mean' and (((pos==1 and p.close>=p['mean']) or (pos==-1 and p.close<=p['mean'])) or (t-et)/pd.Timedelta(hours=1)>=48): xp=float(r.open); why='mean_time'
        if xp is not None:
            gross=pos*(xp/entry-1); out.append({'entry_time':et,'exit_time':t,'side':pos,'expert':who,'entry':entry,'exit':xp,'gross':gross,'net':gross-cost,'reason':why}); pos=0
    return pd.DataFrame(out)

def met(t):
    if t.empty:return {'trades':0,'return':-1.,'pf':0.,'win_rate':0.,'max_dd':-1.,'sharpe':-10.,'positive_months':0.,'trades_week':0.}
    eq=(1+t.net).cumprod(); dd=eq/eq.cummax()-1; gp=t.loc[t.net>0,'net'].sum(); gl=-t.loc[t.net<0,'net'].sum(); daily=t.set_index('exit_time').net.resample('1D').sum(); mo=t.set_index('exit_time').net.resample('ME').sum(); weeks=max((t.exit_time.max()-t.entry_time.min()).days/7,1)
    return {'trades':len(t),'return':float(eq.iloc[-1]-1),'pf':float(gp/gl) if gl>0 else 99.,'win_rate':float((t.net>0).mean()),'max_dd':float(dd.min()),'sharpe':float(np.sqrt(365)*daily.mean()/daily.std()) if daily.std()>0 else 0.,'positive_months':float((mo>0).mean()),'trades_week':float(len(t)/weeks)}

def main():
    x=feat(load()); sel=x.loc['2023-01-01':'2024-12-31']; hold=x.loc['2025-01-01':]; rows=[]
    for z,a,tr in product([1.75,2.,2.25,2.5,2.75],[15,18,20],[2.,2.5,3.,3.5]):
        m=met(bt(sel,z,a,tr,.003)); score=m['sharpe']+.5*np.log(max(m['pf'],1e-6))+2*m['return']+2*m['max_dd']-(2 if m['trades_week']<1 else 0); rows.append({'z':z,'adx':a,'trail':tr,'score':score,**m})
    g=pd.DataFrame(rows).sort_values('score',ascending=False); g.to_csv(OUT/'selection_grid.csv',index=False); b=g.iloc[0]; summary={'selected':b.to_dict(),'holdout':{}}
    mid=None
    for c in COSTS:
        t=bt(hold,float(b.z),int(b.adx),float(b.trail),c); t.to_csv(OUT/f'trades_cost_{c:.3f}.csv',index=False); summary['holdout'][str(c)]=met(t)
        if c==.003: mid=t
    pd.DataFrame(summary['holdout']).T.to_csv(OUT/'holdout_metrics.csv'); (OUT/'summary.json').write_text(json.dumps(summary,indent=2,default=float))
    if mid is not None and not mid.empty:
        plt.figure(figsize=(10,5)); plt.plot(mid.exit_time,(1+mid.net).cumprod()); plt.title('BTC locked holdout equity'); plt.tight_layout(); plt.savefig(OUT/'equity.png',dpi=150)
    print(json.dumps(summary,indent=2,default=float))
if __name__=='__main__': main()
