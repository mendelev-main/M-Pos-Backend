import test from "node:test";
import assert from "node:assert/strict";

function demandStatus(snapshot) {
  if (!snapshot || Number(snapshot.schemaVersion) !== 1 || typeof snapshot?.demand?.overload !== "boolean") {
    return { available:false, demandState:"UNAVAILABLE" };
  }
  const overload=snapshot.demand.overload===true;
  return { available:true, demandState:overload?"OVERLOAD":"NORMAL", overload };
}

test("fresh operational demand false maps to NORMAL",()=>{
  assert.deepEqual(demandStatus({schemaVersion:1,demand:{overload:false}}),{available:true,demandState:"NORMAL",overload:false});
});

test("fresh operational demand true maps to OVERLOAD",()=>{
  assert.deepEqual(demandStatus({schemaVersion:1,demand:{overload:true}}),{available:true,demandState:"OVERLOAD",overload:true});
});

test("missing demand is unavailable instead of guessing",()=>{
  assert.deepEqual(demandStatus({schemaVersion:1}),{available:false,demandState:"UNAVAILABLE"});
});

test("wrong operational schema is unavailable",()=>{
  assert.deepEqual(demandStatus({schemaVersion:2,demand:{overload:true}}),{available:false,demandState:"UNAVAILABLE"});
});

test("non boolean overload is unavailable",()=>{
  assert.deepEqual(demandStatus({schemaVersion:1,demand:{overload:"true"}}),{available:false,demandState:"UNAVAILABLE"});
});
