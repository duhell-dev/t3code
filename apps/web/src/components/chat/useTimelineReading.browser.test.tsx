import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import { expect, it, vi } from "vite-plus/test";

import { act, fakeTimers, render } from "../../../test/render";
import { AppAtomRegistryProvider, appAtomRegistry } from "~/rpc/atomRegistry";
import { threadReadingAtom } from "~/state/threadReading";
import { CATCH_UP_DWELL_MS } from "./threadCatchUp.logic";
import { useTimelineReading } from "./useTimelineReading";

// Headless browsers report no window focus; the reader here is looking.
vi.mock("~/lib/documentActivity", () => ({
  getDocumentActivity: () => ({ visible: true, focused: true }),
  subscribeDocumentActivity: () => () => {},
}));

const at = (minute: number) => `2026-01-01T10:${String(minute).padStart(2, "0")}:00.000Z`;
const answer = (minute: number) => ({
  kind: "message",
  createdAt: at(minute),
  message: { role: "assistant", createdBy: "agent" },
});
const rowOf = (minute: number) => ({ id: `row-${minute}`, kind: "message", createdAt: at(minute) });

function setup(name: string) {
  const ref = {
    environmentId: EnvironmentId.make("env-reading"),
    threadId: ThreadId.make(name),
  };
  const seen: Array<ReturnType<typeof useTimelineReading>> = [];
  function Harness(props: { readonly atEnd: boolean; readonly minutes: ReadonlyArray<number> }) {
    seen.push(
      useTimelineReading({
        identity: scopedThreadKey(ref),
        boundary: at(10),
        atEnd: props.atEnd,
        rows: props.minutes.map(rowOf),
        entries: props.minutes.map(answer),
      }),
    );
    return null;
  }
  const ui = (atEnd: boolean, minutes: ReadonlyArray<number>) => (
    <AppAtomRegistryProvider>
      <Harness atEnd={atEnd} minutes={minutes} />
    </AppAtomRegistryProvider>
  );
  return {
    ui,
    latest: () => seen.at(-1)!,
    sidebar: () => appAtomRegistry.get(threadReadingAtom(ref)),
  };
}

it("reads the thread after the reader stays at the end for the dwell", async () => {
  const t = setup("thread-dwell");
  // The dwell timer starts in the first render, so time is faked before it.
  using _timers = fakeTimers();
  await using screen = await render(t.ui(true, [5, 12, 13]), { router: false }); // no links here
  await act(() => vi.advanceTimersByTime(CATCH_UP_DWELL_MS - 100));
  expect(t.latest().catchUp?.unreadCount).toBe(2);
  expect(t.sidebar().unreadCount).toBe(2);
  await act(() => vi.advanceTimersByTime(200));
  expect(t.latest().catchUp).toBeNull();
  expect(t.sidebar()).toMatchObject({ caughtUp: true, unreadCount: 0 });
  await screen.rerender(t.ui(true, [5, 12, 13]));
});

it("reads nothing when the reader only scrolls past the end", async () => {
  const t = setup("thread-scroll-past");
  // The dwell timer starts in the first render, so time is faked before it.
  using _timers = fakeTimers();
  await using screen = await render(t.ui(true, [5, 12, 13]), { router: false }); // no links here
  await act(() => vi.advanceTimersByTime(500));
  await screen.rerender(t.ui(false, [5, 12, 13]));
  await act(() => vi.advanceTimersByTime(CATCH_UP_DWELL_MS * 3));
  expect(t.latest().catchUp?.unreadCount).toBe(2);
  expect(t.sidebar()).toMatchObject({ caughtUp: false, unreadCount: 2 });
});

it("reads messages that arrive while the reader stays at the end, without a line", async () => {
  const t = setup("thread-follow");
  // The dwell timer starts in the first render, so time is faked before it.
  using _timers = fakeTimers();
  await using screen = await render(t.ui(true, [5]), { router: false }); // no links here
  await act(() => vi.advanceTimersByTime(CATCH_UP_DWELL_MS));
  await screen.rerender(t.ui(true, [5, 14, 15]));
  expect(t.latest().catchUp).toBeNull();
  expect(t.sidebar().unreadCount).toBe(0);
});

it("keeps arrivals unread while the reader is scrolled up, and marks read at once by hand", async () => {
  const t = setup("thread-scrolled-up");
  await using screen = await render(t.ui(false, [5]), { router: false }); // no links here
  await screen.rerender(t.ui(false, [5, 14, 15]));
  expect(t.latest().catchUp).toMatchObject({ rowId: "row-14", unreadCount: 2 });
  expect(t.sidebar()).toMatchObject({ caughtUp: false, unreadCount: 2 });
  await act(() => t.latest().markRead());
  expect(t.latest().catchUp).toBeNull();
  expect(t.sidebar()).toMatchObject({ unreadCount: 0, markedRead: 1 });
});
