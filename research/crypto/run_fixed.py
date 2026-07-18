import io
import zipfile
import requests
import pandas as pd
import backtest

HEADERS=['open_time','open','high','low','close','volume','close_time','quote_volume','trades','taker_base','taker_quote','ignore']

def fixed_load():
    frames=[]
    end=pd.Period(pd.Timestamp.now(tz='UTC').strftime('%Y-%m'),freq='M')
    session=requests.Session()
    for p in pd.period_range('2020-01',end,freq='M'):
        ym=str(p)
        url=f'{backtest.BASE}/BTCUSDT-1h-{ym}.zip'
        r=session.get(url,timeout=45)
        if r.status_code==404:
            continue
        r.raise_for_status()
        with zipfile.ZipFile(io.BytesIO(r.content)) as z:
            a=pd.read_csv(z.open(z.namelist()[0]),header=None)
        a=a.iloc[:,:12]
        a.columns=HEADERS
        ts=pd.to_numeric(a.open_time,errors='coerce')
        a=a.loc[ts.notna()].copy()
        ts=ts.loc[ts.notna()].astype('int64')
        unit='us' if float(ts.median())>1e14 else 'ms'
        a['time']=pd.to_datetime(ts,unit=unit,utc=True,errors='coerce')
        for c in ['open','high','low','close','volume']:
            a[c]=pd.to_numeric(a[c],errors='coerce')
        frames.append(a[['time','open','high','low','close','volume']])
        print('downloaded',ym,len(a),'timestamp_unit',unit)
    if not frames:
        raise RuntimeError('No Binance data downloaded')
    d=pd.concat(frames,ignore_index=True)
    d=d.dropna().drop_duplicates('time').sort_values('time').set_index('time')
    print('dataset',d.index.min(),d.index.max(),len(d))
    return d

backtest.load=fixed_load
backtest.main()
