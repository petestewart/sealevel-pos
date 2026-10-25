"use client";

import { plainText } from "@/lib/richtext";

import WaiverScene from "./WaiverScene";

import type { ContractPayload } from "@/lib/displaycontract";

/**
 * The membership contract, as the student signs it (T205, Phase 2.5
 * item 6; design "Scene 4").
 *
 * It is the WAIVER SCENE with different words above it, on purpose: the
 * scroll-to-the-end rule, the pointer-driven pad, Clear, and the export
 * with the typed name line are one implementation (T202, made reusable
 * by T204) and must stay one. What a contract adds is the summary the
 * student reads before the terms -- what it costs, when it starts and
 * what recurs -- and every line of that was worded by the SERVER from
 * Mindbody's own figures and its own `Test: true` rehearsal. Nothing
 * here formats an amount or a date.
 *
 * THIS COMPONENT WRITES NOTHING, to Mindbody or anywhere else. It POSTs
 * /api/display/complete with the request id and the signature, or
 * /api/display/refuse with "Not now"; the purchase is the teacher's
 * iPad's, under the teacher's own token, through /api/purchase-contract.
 */
export default function ContractScene(props: {
  requestId: string;
  payload: ContractPayload;
  onDone: (name: string | null) => void;
}) {
  const { requestId, payload, onDone } = props;
  /* Every string here is remote, studio-editable text, so it goes
   * through plainText like everything else on this screen and never
   * through dangerouslySetInnerHTML. */
  const name = plainText(payload.clientFirstName ?? "");
  const contractName = plainText(payload.contractName);
  const firstPayment =
    payload.firstPayment === null ? null : plainText(payload.firstPayment);
  const autopay = payload.autopay === null ? null : plainText(payload.autopay);
  const startsOn = plainText(payload.startsOn);

  return (
    <WaiverScene
      requestId={requestId}
      payload={{ text: payload.terms, clientFirstName: payload.clientFirstName }}
      onDone={() => onDone(name || null)}
      heading={name ? `${name}, please read this` : "Please read this"}
      lead={`${contractName}. Read the terms below, then sign.`}
      textLabel={`The terms of the ${contractName} membership`}
      scrollNote="Scroll to the end of the terms to sign."
      agreeLabel="I agree to these terms"
      notNowLabel="Not now"
      /* The refusal says what happened in the words the teacher's screen
         repeats: "Customer did not sign". */
      onNotNow={async () => {
        try {
          await fetch("/api/display/refuse", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              requestId,
              reason: "Customer did not sign",
            }),
          });
        } catch {
          /* The teacher's dialog has the ways out either way. */
        }
      }}
      intro={
        <div className="dcontract-terms" aria-label="What this membership costs">
          <div className="dcontract-row">
            <span>Starts</span>
            <span className="dcontract-amt">{startsOn}</span>
          </div>
          <div className="dcontract-row">
            <span>First payment</span>
            <span className="dcontract-amt">
              {/* Never an invented figure: with no rehearsed total (dry
                  run, the write guard) the screen says where the number
                  comes from instead of making one up. */}
              {firstPayment ?? "as quoted at the counter"}
            </span>
          </div>
          {autopay ? (
            <div className="dcontract-row">
              <span>Recurring</span>
              <span className="dcontract-amt">{autopay}</span>
            </div>
          ) : null}
        </div>
      }
    />
  );
}
