import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { startTestPostgres } from './support/postgres.mjs';
import { ChannelStore } from '../server/channels.mjs';
import { CreationStore } from '../server/creation-store.mjs';
import { ModelHub } from '../server/model-hub.mjs';

let db,channels,hub;
test.before(async()=>{
 db=await startTestPostgres();channels=new ChannelStore(db.pool,randomBytes(32));await channels.init();
 await channels.insert({id:'ch_0000000000000001',name:'Test',baseUrl:'https://provider.example/v1',apiKey:'test-key-not-real'});
 hub=new ModelHub(new CreationStore(db.pool),channels,{transport:async()=>new Response(JSON.stringify({data:[{id:'text-alpha'},{id:'picture-beta'}]}))});
});
test.after(async()=>{await db?.stop();});
test('discovered models persist disabled without guessing capabilities',async()=>{
 await hub.sync('ch_0000000000000001');
 const result=await hub.catalog();
 assert.equal(result.models.length,2);
 assert.equal(result.models[0].enabled,false);
 assert.deepEqual(result.models[0].capabilities,[]);
});
