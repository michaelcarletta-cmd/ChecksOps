import "https://deno.land/std@0.224.0/dotenv/load.ts";
import { assertEquals } from "https://deno.land/std@0.224.0/assert/assert_equals.ts";
import { parseDateStrict } from "./index.ts";

Deno.test("parseDateStrict: MM/DD/YYYY", () => {
  assertEquals(parseDateStrict("02/19/2025"), "2025-02-19T12:00:00.000Z");
});

Deno.test("parseDateStrict: M/D/YY (2-digit year)", () => {
  assertEquals(parseDateStrict("2/9/25"), "2025-02-09T12:00:00.000Z");
});

Deno.test("parseDateStrict: YYYY-MM-DD", () => {
  assertEquals(parseDateStrict("2025-02-20"), "2025-02-20T12:00:00.000Z");
});

Deno.test("parseDateStrict: Month DD, YYYY", () => {
  assertEquals(parseDateStrict("February 19, 2025"), "2025-02-19T12:00:00.000Z");
});

Deno.test("parseDateStrict: Mon. DD, YYYY", () => {
  assertEquals(parseDateStrict("Feb. 19, 2025"), "2025-02-19T12:00:00.000Z");
});

Deno.test("parseDateStrict: strips surrounding punctuation", () => {
  assertEquals(parseDateStrict(",02/19/2025."), "2025-02-19T12:00:00.000Z");
});

Deno.test("parseDateStrict: rejects future year", () => {
  assertEquals(parseDateStrict("01/01/2099"), null);
});

Deno.test("parseDateStrict: rejects old year", () => {
  assertEquals(parseDateStrict("01/01/1990"), null);
});

Deno.test("parseDateStrict: rejects garbage", () => {
  assertEquals(parseDateStrict("hello world"), null);
});

Deno.test("parseDateStrict: all outputs are noon UTC", () => {
  const results = [
    parseDateStrict("02/19/2025"),
    parseDateStrict("2/9/25"),
    parseDateStrict("2025-02-20"),
    parseDateStrict("February 19, 2025"),
    parseDateStrict("Feb. 19, 2025"),
  ];
  for (const r of results) {
    assertEquals(r !== null && r.endsWith("T12:00:00.000Z"), true, `Expected noon UTC, got: ${r}`);
  }
});
