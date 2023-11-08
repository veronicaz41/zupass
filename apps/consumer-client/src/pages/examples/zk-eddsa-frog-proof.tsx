import {
  EdDSAFrogPCDPackage
} from "@pcd/eddsa-frog-pcd";
import {
  constructZupassPcdGetRequestUrl,
  openZupassPopup,
  useSerializedPCD,
  useZupassPopupMessages
} from "@pcd/passport-interface";
import { ArgumentTypeName } from "@pcd/pcd-types";
import { SemaphoreIdentityPCDPackage } from "@pcd/semaphore-identity-pcd";
import { generateSnarkMessageHash } from "@pcd/util";
import {
  ZKEdDSAFrogPCD,
  ZKEdDSAFrogPCDArgs,
  ZKEdDSAFrogPCDPackage
} from "@pcd/zk-eddsa-frog-pcd";
import { useEffect, useState } from "react";
import { CollapsableCode, HomeLink } from "../../components/Core";
import { ExampleContainer } from "../../components/ExamplePage";
import { ZUPASS_URL } from "../../constants";

export default function Page() {
  const externalNullifier =
    generateSnarkMessageHash("consumer-client").toString();

  // Populate PCD from either client-side or server-side proving using the Zupass popup
  const [pcdStr] = useZupassPopupMessages();

  const [valid, setValid] = useState<boolean | undefined>();
  const onVerified = (valid: boolean) => {
    setValid(valid);
  };

  const { pcd } = useZKEdDSAFrogProof(
    pcdStr,
    onVerified,
    externalNullifier
  );

  return (
    <>
      <HomeLink />
      <h2>ZK EdDSA Frog Proof</h2>
      <p>
        This page shows a working example of an integration with Zupass which
        requests and verifies that the user has an EdDSA-signed frog, without
        revealing the user's semaphore identity.
      </p>
      <ExampleContainer>
        <button
          onClick={() =>
            openZKEdDSAFrogPopup(
              ZUPASS_URL,
              window.location.origin + "#/popup",
              externalNullifier
            )
          }
          disabled={valid}
        >
          Request ZK EdDSA Frog Proof from Zupass
        </button>
        <br />
        <br />
        {!!pcd && (
          <>
            <p>Got ZK EdDSA Frog Proof from Zupass</p>
            <CollapsableCode code={JSON.stringify(pcd, null, 2)} />
            {valid === undefined && <p>❓ Proof verifying</p>}
            {valid === false && <p>❌ Proof is invalid</p>}
            {valid === true && (
              <>
                <p>✅ Proof is valid</p>
                <p>{`Frog ID: ${pcd.claim.frogOmitOwner.frogId}`}</p>
                <p>{`Biome: ${pcd.claim.frogOmitOwner.biome}`}</p>
                <p>{`Rarity: ${pcd.claim.frogOmitOwner.rarity}`}</p>
                <p>{`Temperament: ${pcd.claim.frogOmitOwner.temperament}`}</p>
                <p>{`Jump: ${pcd.claim.frogOmitOwner.jump}`}</p>
                <p>{`Speed: ${pcd.claim.frogOmitOwner.speed}`}</p>
                <p>{`Intelligence: ${pcd.claim.frogOmitOwner.intelligence}`}</p>
                <p>{`Beauty: ${pcd.claim.frogOmitOwner.beauty}`}</p>
                <p>{`Timestamp Signed: ${pcd.claim.frogOmitOwner.timestampSigned}`}</p>
                <p>{`Signer: ${pcd.claim.signerPublicKey}`}</p>
                <p>{`External Nullifier: ${pcd.claim.externalNullifier}`}</p>
                <p>{`Nullifier Hash: ${pcd.claim.nullifierHash}`}</p>
              </>
            )}
          </>
        )}
        {valid && <p>Welcome, anon</p>}
      </ExampleContainer>
    </>
  );
}

/**
 * Opens a Zupass popup to prove a ZKEdDSAFrogPCD.
 *
 * @param urlToZupassWebsite URL of the Zupass website
 * @param popupUrl Route where the useZupassPopupSetup hook is being served from
 * @param externalNullifier Optional unique identifier for this ZKEdDSAFrogPCD
 */
export function openZKEdDSAFrogPopup(
  urlToZupassWebsite: string,
  popupUrl: string,
  externalNullifier?: string
) {
  const args: ZKEdDSAFrogPCDArgs = {
    frog: {
      argumentType: ArgumentTypeName.PCD,
      pcdType: EdDSAFrogPCDPackage.name,
      value: undefined,
      userProvided: true,
      validatorParams: {
        notFoundMessage: "No eligible EdDSA Frog PCDs found"
      }
    },
    identity: {
      argumentType: ArgumentTypeName.PCD,
      pcdType: SemaphoreIdentityPCDPackage.name,
      value: undefined,
      userProvided: true
    },
    externalNullifier: {
      argumentType: ArgumentTypeName.BigInt,
      value: externalNullifier,
      userProvided: false
    },
  };

  const proofUrl = constructZupassPcdGetRequestUrl<
    typeof ZKEdDSAFrogPCDPackage
  >(urlToZupassWebsite, popupUrl, ZKEdDSAFrogPCDPackage.name, args, {
    genericProveScreen: true,
    title: "ZK EdDSA Frog Proof",
    description: "zk eddsa frog pcd request"
  });

  openZupassPopup(popupUrl, proofUrl);
}

/**
 * React hook which can be used on 3rd party application websites that
 * parses and verifies a PCD representing a ZKEdDSA frog proof.
 */
function useZKEdDSAFrogProof(
  pcdStr: string,
  onVerified: (valid: boolean) => void,
  externalNullifier?: string
): { pcd: ZKEdDSAFrogPCD | undefined; error: any } {
  const [error, _setError] = useState<Error | undefined>();
  const zkEdDSAFrogPCD = useSerializedPCD(
    ZKEdDSAFrogPCDPackage,
    pcdStr
  );

  useEffect(() => {
    if (zkEdDSAFrogPCD) {
      verifyProof(
        zkEdDSAFrogPCD,
        externalNullifier
      ).then(onVerified);
    }
  }, [
    zkEdDSAFrogPCD,
    externalNullifier,
    onVerified
  ]);

  return {
    pcd: zkEdDSAFrogPCD,
    error
  };
}

async function verifyProof(
  pcd: ZKEdDSAFrogPCD,
  externalNullifier?: string
): Promise<boolean> {
  const { verify } = ZKEdDSAFrogPCDPackage;
  const verified = await verify(pcd);
  if (!verified) return false;

  // verify the claim is for the correct externalNullifier
  const sameExternalNullifier =
    pcd.claim.externalNullifier === externalNullifier ||
    (!pcd.claim.externalNullifier && !externalNullifier);
  return sameExternalNullifier;
}
