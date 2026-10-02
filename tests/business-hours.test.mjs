import test from "node:test";
import assert from "node:assert/strict";
import { isOrderingOpen, isSiteSleepWindow, millisecondsUntilSiteWake, venueMinute } from "../business-hours.js";

const zone="Europe/Minsk";
const at=iso=>new Date(iso);

test("guest site sleeps from midnight until 06:00 venue time",()=>{
  assert.equal(venueMinute(at("2026-10-02T21:00:00Z"),zone),0);
  assert.equal(isSiteSleepWindow(at("2026-10-03T02:59:00Z"),zone),true);
  assert.equal(isSiteSleepWindow(at("2026-10-03T03:00:00Z"),zone),false);
  assert.equal(millisecondsUntilSiteWake(at("2026-10-02T21:30:00Z"),zone),5.5*60*60*1000);
});

test("online ordering is accepted only from 10:00 until 23:00 venue time",()=>{
  assert.equal(isOrderingOpen(at("2026-10-03T06:59:00Z"),zone),false);
  assert.equal(isOrderingOpen(at("2026-10-03T07:00:00Z"),zone),true);
  assert.equal(isOrderingOpen(at("2026-10-03T19:59:00Z"),zone),true);
  assert.equal(isOrderingOpen(at("2026-10-03T20:00:00Z"),zone),false);
});
