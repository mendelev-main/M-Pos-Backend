import test from "node:test";
import assert from "node:assert/strict";
import { closedPageHtml, isOrderingOpen, isSiteSleepWindow, millisecondsUntilSiteWake, venueMinute } from "../business-hours.js";

const zone="Europe/Minsk";
const at=iso=>new Date(iso);

test("guest site sleeps from midnight until 06:00 venue time",()=>{
  assert.equal(venueMinute(at("2026-10-02T21:00:00Z"),zone),0);
  assert.equal(isSiteSleepWindow(at("2026-10-03T02:59:00Z"),zone),true);
  assert.equal(isSiteSleepWindow(at("2026-10-03T03:00:00Z"),zone),false);
  assert.equal(millisecondsUntilSiteWake(at("2026-10-02T21:30:00Z"),zone),5.5*60*60*1000);
});

test("online ordering is accepted only from 10:00 until 22:30 venue time",()=>{
  assert.equal(isOrderingOpen(at("2026-10-03T06:59:00Z"),zone),false);
  assert.equal(isOrderingOpen(at("2026-10-03T07:00:00Z"),zone),true);
  assert.equal(isOrderingOpen(at("2026-10-03T19:29:59Z"),zone),true);
  assert.equal(isOrderingOpen(at("2026-10-03T19:30:00Z"),zone),false);
});

test("overnight page shows the venue message and working hours",()=>{
  const html=closedPageHtml();
  assert.match(html,/Ушли отдыхать, скоро вернемся/);
  assert.match(html,/Работаем с 10:00 до 23:00/);
});

 test("ordering banner reuses the mascot and gives the correct reopening day",()=>{
 const evening=closedPageHtml({ordering:true,date:at("2026-10-03T19:30:00Z")});
 assert.match(evening,/Пошли наводить порядок/);
 assert.match(evening,/Встретимся завтра в 10:00/);
 assert.match(evening,/sleeping-mascot-v1.webp/);
 assert.match(evening,/href="\/menu\/"/);
 const morning=closedPageHtml({ordering:true,date:at("2026-10-04T04:00:00Z")});
 assert.match(morning,/сегодня в 10:00/);
});
