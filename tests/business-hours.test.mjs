import test from "node:test";
import assert from "node:assert/strict";
import { closedPageHtml, isOrderingOpen, isSiteSleepWindow, millisecondsUntilSiteWake, venueMinute } from "../business-hours.js";

const zone="Europe/Minsk";
const at=iso=>new Date(iso);

test("menu stays open while checkout accepts orders only from 10:00 inclusive to 22:00 exclusive Minsk",()=>{
 for(const [iso,open] of [["2026-10-03T06:59:59Z",false],["2026-10-03T07:00:00Z",true],["2026-10-03T18:59:59Z",true],["2026-10-03T19:00:00Z",false],["2026-10-03T21:00:00Z",false]]){assert.equal(isSiteSleepWindow(at(iso),zone),false);assert.equal(isOrderingOpen(at(iso),zone),open);}
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
 assert.match(evening,/href="\/privacy\/manage"/);
 const morning=closedPageHtml({ordering:true,date:at("2026-10-04T04:00:00Z")});
 assert.match(morning,/сегодня в 10:00/);
});
