"""Execute generated project-owned publication and callback with synthetic adapters."""
import json
import sys
import types
from datetime import datetime, timezone, timedelta

# Generated publisher core is native source under test; the cloud/credential wrapper
# below CONFIG is never run. No arbitrary project Python is executed by the CLI.
code = open(sys.argv[1], encoding='utf-8').read()
core = code.split('\nCONFIG = json.loads(', 1)[0]
publication = {}
exec(compile(core, 'generated-publication.py', 'exec'), publication)
notebook = json.load(open(sys.argv[2], encoding='utf-8'))
source = ''.join(notebook['cells'][-1]['source'])
state = {'rows':2,'index':None,'loaded':None}
class Frame:
    def count(self): return state['rows']
    def filter(self,_): return Small()
    def groupBy(self,*_): return Group()
class Small:
    def count(self): return 0
    def limit(self,_): return self
class Group:
    def count(self): return self
    def filter(self,_): return Small()
class Expression:
    def __invert__(self): return self
    def __gt__(self,_): return self
class Reader:
    def option(self,*_): return self
    def text(self,_): return self
    def take(self,_): return [types.SimpleNamespace(value=state['index'])]
    def format(self,_): return self
    def schema(self,_): return self
    def load(self,path): state['loaded']=path;return Frame()
dp = types.SimpleNamespace(create_streaming_table=lambda **_:None,create_auto_cdc_from_snapshot_flow=lambda **_:None,materialized_view=lambda **_:lambda f:f)
functions = types.SimpleNamespace(expr=lambda _:Expression(),lit=lambda _:Expression(),coalesce=lambda *_:Expression(),col=lambda _:Expression())
sys.modules['pyspark']=types.SimpleNamespace(pipelines=dp)
sys.modules['pyspark.sql']=types.SimpleNamespace(functions=functions)
namespace={'spark':types.SimpleNamespace(read=Reader())}
exec(compile(source,'generated-snapshot.ipynb','exec'),namespace)
callback=next(v for k,v in namespace.items() if k.startswith('next_') and callable(v))
root=namespace['SOURCE_ROOT']
class Store:
    etag=None
    def read(self): return (state['index'].encode() if state['index'] else None,self.etag)
    def compare_and_swap(self,body,etag):
        assert etag==self.etag
        state['index']=body.decode();self.etag=str(int(self.etag or '0')+1)
store=Store()
first=dict(id='snapshot_1',version=1,capturedAt=(datetime.now(timezone.utc)-timedelta(hours=2)).isoformat(),contractVersion='1.0.0',complete=True,scope='full-table',rowCount=2,path=root+'/run_1')
publish=publication['publish_snapshot']
publish(store,first,'retail.source.customers',root,lambda:None,initialise=True)
assert callback(None)[1]==1
second={**first,'id':'snapshot_2','version':2,'path':root+'/run_2'}
publish(store,second,'retail.source.customers',root,lambda:None)
assert callback(1)[1]==2
assert state['loaded']==second['path']
assert callback(2) is None
assert publish(store,second,'retail.source.customers',root,lambda:None)['status']=='already-published'
# A fresh consumer can still replay the complete retained index from version one.
assert callback(None)[1]==1
assert callback(1)[1]==2
assert len(json.loads(state['index'])['deliveries'])==2
print('Generated publication and consumer replay passed (synthetic, no Azure/Spark).')
