import test from "node:test";
import assert from "node:assert/strict";

const STATIONS=["bar","kitchen"];
const difficultyMultiplier=v=>[0,0.80,0.95,1.10,1.30,1.55][Math.max(1,Math.min(5,Number(v)||1))];
const batchFactor=qty=>{const q=Math.max(0,Number(qty)||0);return q<=1?q:1+(q-1)*0.72;};
function prepWork(lines,catalog){
  const result={bar:{durationMinutes:0,workPoints:0},kitchen:{durationMinutes:0,workPoints:0}};
  for(const line of lines){const prep=catalog.get(line.id);if(!prep)throw new Error("PREP_MISSING");if(prep.station==="none")continue;const q=Number(line.qty);result[prep.station].durationMinutes+=Number(prep.basePrepMinutes)*batchFactor(q);result[prep.station].workPoints+=q*difficultyMultiplier(prep.difficulty);}
  return result;
}
function findSlot(start,duration,reservations){let s=start,d=duration*60000;for(const r of reservations.slice().sort((a,b)=>a.startAt-b.startAt)){if(s+d<=r.startAt)break;if(s<r.endAt&&s+d>r.startAt)s=r.endAt;}return s;}
function estimate(snapshot,work,now,requestedReadyAt=null){
  const stations={};for(const station of STATIONS){const duration=work[station].durationMinutes,currentWait=Number(snapshot.production.stations[station].waitMinutes)||0;const reservations=(snapshot.scheduled||[]).map(o=>{const d=Number(o.work?.[station]?.durationMinutes)||0,r=Number(o.requestedReadyAt)||0;return d&&r?{startAt:r-d*60000,endAt:r}:null;}).filter(Boolean);const desired=requestedReadyAt&&duration?Math.max(now,requestedReadyAt-duration*60000):now;const start=duration?findSlot(Math.max(desired,now+currentWait*60000),duration,reservations):now;stations[station]={wait:(start-now)/60000,completion:(start-now)/60000+duration};}const participating=STATIONS.filter(s=>work[s].durationMinutes>0);const critical=participating.sort((a,b)=>stations[b].completion-stations[a].completion)[0]||null;return {stations,critical};}

test("difficulty changes workload but not duration",()=>{const c1=new Map([["x",{station:"kitchen",basePrepMinutes:10,difficulty:1}]]),c5=new Map([["x",{station:"kitchen",basePrepMinutes:10,difficulty:5}]]);const a=prepWork([{id:"x",qty:1}],c1).kitchen,b=prepWork([{id:"x",qty:1}],c5).kitchen;assert.equal(a.durationMinutes,b.durationMinutes);assert.ok(b.workPoints>a.workPoints);});
test("bar load does not delay kitchen-only cart",()=>{const snap={production:{stations:{bar:{waitMinutes:40},kitchen:{waitMinutes:0}}},scheduled:[]};const work={bar:{durationMinutes:0},kitchen:{durationMinutes:10}};const r=estimate(snap,work,0);assert.equal(r.stations.kitchen.wait,0);assert.equal(r.critical,"kitchen");});
test("mixed order is ready by latest station",()=>{const snap={production:{stations:{bar:{waitMinutes:0},kitchen:{waitMinutes:20}}},scheduled:[]};const work={bar:{durationMinutes:15},kitchen:{durationMinutes:10}};assert.equal(estimate(snap,work,0).critical,"kitchen");});
test("future reservation only blocks overlapping work",()=>{const now=1_000_000,ready=now+120*60000;const snap={production:{stations:{bar:{waitMinutes:0},kitchen:{waitMinutes:0}}},scheduled:[{requestedReadyAt:ready,work:{kitchen:{durationMinutes:20}}}]};const short={bar:{durationMinutes:0},kitchen:{durationMinutes:10}};assert.equal(estimate(snap,short,now).stations.kitchen.wait,0);const requested=ready;assert.ok(estimate(snap,short,now,requested).stations.kitchen.wait>=120);});
