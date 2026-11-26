import {
  SECRET_REQUEST_OUTDATED_CLIENT_PLACEHOLDER,
  SecretRequestAnswerInput,
  SecretRequestError,
  type EnvironmentId,
  type OrchestrationV2ProjectedTurnItem,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Schema from "effect/Schema";
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";

const harness = vi.hoisted(() => ({
  sent: [] as Array<unknown>,
  result: { _tag: "Success" } as unknown,
}));

type Children = { children?: ReactNode };

vi.mock("react-native", () => ({
  View: ({ children }: Children) => <div>{children}</div>,
}));
vi.mock("gt-react-native", () => ({
  useGT: () => (text: string) => text,
  useMessages: () => (text: string) => text,
}));
vi.mock("@effect/atom-react", () => ({ useAtomValue: () => null }));
vi.mock("../../components/ui/AppSymbol", () => ({ SymbolView: () => null }));
vi.mock("../../components/ui/AppText", () => ({
  AppText: ({ children }: Children) => <span>{children}</span>,
  AppTextInput: () => null,
}));
vi.mock("../../components/ui/SecretTextInput", () => ({
  SecretTextInput: (props: {
    accessibilityLabel: string;
    placeholder: string;
    value: string;
    secret?: boolean;
    onChangeText: (value: string) => void;
  }) => (
    <input
      aria-label={props.accessibilityLabel}
      placeholder={props.placeholder}
      type={props.secret === false ? "text" : "password"}
      value={props.value}
      onChange={(event) => props.onChangeText(event.target.value)}
    />
  ),
}));
vi.mock("../../components/ui/Button", () => ({
  Button: (props: { label: string; disabled?: boolean; onPress: () => void }) => (
    <button type="button" disabled={props.disabled} onClick={props.onPress}>
      {props.label}
    </button>
  ),
}));
vi.mock("../../components/ui/Chip", () => ({ Chip: () => null }));
vi.mock("../../lib/openExternalUrl", () => ({ tryOpenExternalUrl: () => undefined }));
vi.mock("../../state/server", () => ({
  serverEnvironment: { answerSecretRequest: {}, configValueAtom: () => ({}) },
}));
vi.mock("../../state/session", () => ({ useEnvironmentScope: () => false }));
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand:
    () =>
    async (value: { readonly input: unknown }): Promise<unknown> => {
      harness.sent.push(value.input);
      return harness.result;
    },
}));

import { SecretRequestCard } from "./SecretRequestCard";

// The card from the report: delivery "file", three fields, two of them not secret.
const projectedItem = {
  visibility: "local",
  item: {
    id: "turn-item:secret-request:1",
    threadId: "thread-1",
    runId: "run-1",
    nodeId: "node-1",
    type: "secret_request",
    label: "Staging login",
    reason: "Signs in the QA account.",
    delivery: "file",
    placeholder: SECRET_REQUEST_OUTDATED_CLIENT_PLACEHOLDER,
    fields: [
      { name: "server", label: "Server", secret: false },
      { name: "user", label: "User", secret: false },
      { name: "password", label: "Password" },
    ],
    secretStatus: "pending",
  },
} as unknown as OrchestrationV2ProjectedTurnItem;

const encodeAnswer = Schema.encodeSync(SecretRequestAnswerInput);
const decodeAnswer = Schema.decodeUnknownSync(SecretRequestAnswerInput);

const setInputValue = (input: HTMLInputElement, value: string) => {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
};

async function fillAndSave() {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  harness.sent = [];
  const container = document.createElement("div");
  const root = createRoot(container);
  act(() =>
    root.render(
      <SecretRequestCard
        environmentId={"env-1" as EnvironmentId}
        projectedItem={projectedItem}
        iconColor="#000"
      />,
    ),
  );
  const inputs = [...container.querySelectorAll("input")];
  const save = () =>
    [...container.querySelectorAll("button")].find((b) => b.textContent === "Save securely")!;
  expect(save().disabled).toBe(true);
  act(() => {
    setInputValue(inputs[0]!, "https://staging.example.dev");
    setInputValue(inputs[1]!, "qa@example.dev");
  });
  // Two of three filled is not an answer yet.
  expect(save().disabled).toBe(true);
  act(() => setInputValue(inputs[2]!, "hunter2"));
  expect(save().disabled).toBe(false);
  await act(async () => save().click());
  return { container, inputs, root };
}

it("a card with fields shows one input per field and sends every value under its field name", async () => {
  harness.result = { _tag: "Success" };
  const { inputs, root } = await fillAndSave();

  expect(inputs.map((input) => [input.getAttribute("aria-label"), input.type])).toEqual([
    ["Server", "text"],
    ["User", "text"],
    ["Password", "password"],
  ]);
  // The hint for apps from before `fields` never shows here.
  expect(inputs.map((input) => input.placeholder)).not.toContain(
    SECRET_REQUEST_OUTDATED_CLIENT_PLACEHOLDER,
  );
  expect(harness.sent).toHaveLength(1);
  // Through the RPC payload schema and JSON, as the socket carries it.
  const wire = JSON.parse(JSON.stringify(encodeAnswer(harness.sent[0] as never)));
  expect(decodeAnswer(wire)).toEqual({
    threadId: "thread-1",
    turnItemId: "turn-item:secret-request:1",
    answer: {
      type: "save",
      values: {
        server: "https://staging.example.dev",
        user: "qa@example.dev",
        password: "hunter2",
      },
    },
  });
  act(() => root.unmount());
});

it("a refused answer shows the server's reason and puts the typed values back", async () => {
  harness.result = {
    _tag: "Failure",
    cause: Cause.fail(new SecretRequestError({ reason: "fields_mismatch" })),
  };
  const { container, inputs, root } = await fillAndSave();

  expect(container.querySelector("[role=alert]")?.textContent ?? container.textContent).toContain(
    "This request asks for different values. Update the app and try again.",
  );
  expect(container.textContent).not.toContain("Could not answer the request");
  expect(inputs.map((input) => input.value)).toEqual([
    "https://staging.example.dev",
    "qa@example.dev",
    "hunter2",
  ]);
  act(() => root.unmount());
});
