import assert from 'node:assert/strict';
import http from 'node:http';
import { after, before, test } from 'node:test';
import { decodeConnection, remoteCall } from '../src/core.mjs';
import { handleRpc } from '../src/agent.mjs';

let server;
let url;
const token='abc123';

before(async()=>{
  server=http.createServer((req,res)=>{
    if(req.headers.authorization!==`Bearer ${token}`){
      res.writeHead(401,{'content-type':'application/json'});
      res.end(JSON.stringify({ok:false,error:{code:'UNAUTHORIZED',message:'Unauthorized'}}));
      return;
    }
    const chunks=[];
    req.on('data',c=>chunks.push(c));
    req.on('end',()=>{
      const body=JSON.parse(Buffer.concat(chunks).toString('utf8'));
      let result;
      if(body.action==='initialize') result={protocolVersion:'cosplus-test',workspace:{name:'demo'}};
      else if(body.action==='tools_list') result={tools:[{name:'read',inputSchema:{type:'object'}}]};
      else if(body.action==='tools_call') result={content:[{type:'text',text:'ok'}],structuredContent:{echo:body.args},isError:false};
      else if(body.action==='resources_list') result={resources:[{uri:'resource://workspace/tree'}]};
      else if(body.action==='tasks_get') result={taskId:body.args.task_id,status:'running'};
      else result={action:body.action,args:body.args};
      res.writeHead(200,{'content-type':'application/json'});
      res.end(JSON.stringify({ok:true,result}));
    });
  });
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  url='https://example.test';
  const address=server.address();
  const orig=globalThis.fetch;
  globalThis.__origFetch=orig;
  globalThis.fetch=(input,init)=>orig(String(input).replace('https://example.test',`http://127.0.0.1:${address.port}`),init);
});

after(async()=>{
  globalThis.fetch=globalThis.__origFetch;
  await new Promise(r=>server.close(r));
});

test('decodeConnection accepts https bundle',()=>{
  const payload=Buffer.from(JSON.stringify({v:1,url,token}),'utf8').toString('base64url');
  assert.deepEqual(decodeConnection(`cosplus://v1/${payload}`),{url,token});
});

test('remoteCall surfaces structured errors', async()=>{
  await assert.rejects(()=>remoteCall({url,token:'wrong'},'initialize',{}),(e)=>e.code==='UNAUTHORIZED'&&/Unauthorized/.test(e.message));
});

test('JSON-RPC agent maps initialize and tools/call',async()=>{
  const config={url,token};
  const init=await handleRpc(config,{jsonrpc:'2.0',id:1,method:'initialize',params:{}});
  assert.equal(init.result.protocolVersion,'cosplus-test');
  const call=await handleRpc(config,{jsonrpc:'2.0',id:2,method:'tools/call',params:{name:'read',arguments:{path:'x'}}});
  assert.equal(call.result.isError,false);
  assert.equal(call.result.structuredContent.echo.name,'read');
});

test('JSON-RPC agent maps resources and tasks',async()=>{
  const config={url,token};
  const resources=await handleRpc(config,{jsonrpc:'2.0',id:3,method:'resources/list'});
  assert.equal(resources.result.resources[0].uri,'resource://workspace/tree');
  const task=await handleRpc(config,{jsonrpc:'2.0',id:4,method:'tasks/get',params:{taskId:'process:9'}});
  assert.equal(task.result.taskId,'process:9');
});

test('JSON-RPC agent returns standard method-not-found error',async()=>{
  const res=await handleRpc({url,token},{jsonrpc:'2.0',id:5,method:'nope'});
  assert.equal(res.error.code,-32601);
});
