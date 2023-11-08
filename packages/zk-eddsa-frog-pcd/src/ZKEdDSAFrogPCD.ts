import {
  EdDSAFrogPCD,
  EdDSAFrogPCDPackage,
  EdDSAPCDTypeName,
  IFrogData,
  frogDataToBigInts
} from "@pcd/eddsa-frog-pcd";
import type { EdDSAPublicKey } from "@pcd/eddsa-pcd";
import {
  ArgumentTypeName,
  BigIntArgument,
  DisplayOptions,
  PCD,
  PCDArgument,
  PCDPackage,
  ProveDisplayOptions,
  SerializedPCD
} from "@pcd/pcd-types";
import {
  SemaphoreIdentityPCD,
  SemaphoreIdentityPCDPackage
} from "@pcd/semaphore-identity-pcd";
import { STATIC_SIGNATURE_PCD_NULLIFIER } from "@pcd/semaphore-signature-pcd";
import {
  fromHexString,
  generateSnarkMessageHash,
  hexToBigInt,
  requireDefinedParameter
} from "@pcd/util";
import {
  Groth16Proof,
  prove as groth16Prove,
  verify as groth16Verify
} from "@zk-kit/groth16";
import { Eddsa, buildEddsa } from "circomlibjs";
import JSONBig from "json-bigint";
import { v4 as uuid } from "uuid";
import vkey from "../artifacts/circuit.json";
import { ZKEdDSAFrogCardBody } from "./CardBody";

export const STATIC_ZK_EDDSA_FROG_PCD_NULLIFIER = generateSnarkMessageHash(
  "hard-coded-zk-eddsa-frog-pcd-nullifier"
);

/**
 * The global unique type name of the {@link ZKEdDSAEventTicketPCD}.
 */
export const ZKEdDSAFrogPCDTypeName = "zk-eddsa-frog-pcd";

/**
 * Interface containing the arguments that 3rd parties use to
 * initialize this PCD package.
 * These are the artifacts associated with the circom circuit.
 */
export interface ZKEdDSAFrogPCDInitArgs {
  zkeyFilePath: string;
  wasmFilePath: string;
}

let initArgs: ZKEdDSAFrogPCDInitArgs | undefined = undefined;

/**
 * Defines the essential paratmeters required for creating an {@link ZKEdDSAEventTicketPCD}.
 */
export type ZKEdDSAFrogPCDArgs = {
  frog: PCDArgument<EdDSAFrogPCD>;

  identity: PCDArgument<SemaphoreIdentityPCD>;

  externalNullifier: BigIntArgument;

  watermark: BigIntArgument;
};

/**
 * Defines the ZKEdDSAEventTicketPCD claim.
 */
export interface ZKEdDSAFrogPCDClaim {
  frogOmitOwner: Omit<IFrogData, "ownerSemaphoreId">;
  signerPublicKey: EdDSAPublicKey;
  externalNullifier: string;
  nullifierHash: string;
  watermark: string;
}

/**
 * The ZK EdDSA Frog PCD enables the verification that an owner with a Semaphore
 * identity owns the EdDSA Frog PCD while keeping the owner's semaphore identity private.
 */
export class ZKEdDSAFrogPCD
  implements PCD<ZKEdDSAFrogPCDClaim, Groth16Proof>
{
  type = ZKEdDSAFrogPCDTypeName;

  public constructor(
    readonly id: string,
    readonly claim: ZKEdDSAFrogPCDClaim,
    readonly proof: Groth16Proof
  ) {
    this.id = id;
    this.claim = claim;
    this.proof = proof;
  }
}

export async function init(args: ZKEdDSAFrogPCDInitArgs): Promise<void> {
  initArgs = args;
}

export function getProveDisplayOptions(): ProveDisplayOptions<ZKEdDSAFrogPCDArgs> {
  return {
    defaultArgs: {
      frog: {
        argumentType: ArgumentTypeName.PCD,
        description: "Generate a proof for the selected frog",
        validate(value, _) {
          if (value.type !== EdDSAPCDTypeName || !value.claim) {
            return false;
          }
          return true;
        },
        validatorParams: {
          notFoundMessage: "You do not have any eligible frogs."
        }
      },
      identity: {
        argumentType: ArgumentTypeName.PCD,
        defaultVisible: false,
        description:
          "Your Zupass comes with a primary Semaphore Identity which represents an user in the Semaphore protocol."
      },
      externalNullifier: {
        argumentType: ArgumentTypeName.BigInt,
        defaultVisible: false
      },
      watermark: {
        argumentType: ArgumentTypeName.BigInt,
        defaultVisible: false
      },
    }
  };
}

let initializedPromise: Promise<void> | undefined;
let eddsa: Eddsa;

/**
 * A promise designed to make sure that the EdDSA algorithm
 * of the `circomlibjs` package has been properly initialized.
 * It only initializes them once.
 */
async function ensureEddsaInitialized() {
  if (!initializedPromise) {
    initializedPromise = (async () => {
      eddsa = await buildEddsa();
    })();
  }

  await initializedPromise;
}

async function checkProveInputs(args: ZKEdDSAFrogPCDArgs): Promise<{
  frogPCD: EdDSAFrogPCD;
  identityPCD: SemaphoreIdentityPCD;
  externalNullifier: string;
  watermark: bigint;
}> {
  const serializedFrogPCD = args.frog.value?.pcd;
  if (!serializedFrogPCD) {
    throw new Error("Cannot make proof: missing frog PCD");
  }

  const serializedIdentityPCD = args.identity.value?.pcd;
  if (!serializedIdentityPCD) {
    throw new Error("Cannot make proof: missing identity PCD");
  }

  const externalNullifier = args.externalNullifier.value ||
    STATIC_ZK_EDDSA_FROG_PCD_NULLIFIER.toString()
  if (externalNullifier === STATIC_SIGNATURE_PCD_NULLIFIER.toString()) {
    throw new Error(
      "Cannot make proof: same externalNullifier as SemaphoreSignaturePCD, which would break anonymity"
    );
  }

  if (!args.watermark.value) {
    throw new Error("Cannot make proof: missing watermark");
  }

  const frogPCD =
    await EdDSAFrogPCDPackage.deserialize(serializedFrogPCD);

  const identityPCD =
    await SemaphoreIdentityPCDPackage.deserialize(serializedIdentityPCD);

  return {
    frogPCD,
    identityPCD,
    externalNullifier,
    watermark: BigInt(args.watermark.value)
  };
}

function snarkInputForProof(
  frogPCD: EdDSAFrogPCD,
  identityPCD: SemaphoreIdentityPCD,
  externalNullifer: string,
  watermark: string
): Record<string, `${number}` | `${number}`[]> {
  const frogAsBigIntArray = frogDataToBigInts(frogPCD.claim.data);
  const signerPubKey = frogPCD.proof.eddsaPCD.claim.publicKey;
  const rawSig = eddsa.unpackSignature(
    fromHexString(frogPCD.proof.eddsaPCD.proof.signature)
  );

  return {
    // Frog data fields
    frogId: frogAsBigIntArray[0].toString(),
    biome: frogAsBigIntArray[1].toString(),
    rarity: frogAsBigIntArray[2].toString(),
    temperament: frogAsBigIntArray[3].toString(),
    jump: frogAsBigIntArray[4].toString(),
    speed: frogAsBigIntArray[5].toString(),
    intelligence: frogAsBigIntArray[6].toString(),
    beauty: frogAsBigIntArray[7].toString(),
    timestampSigned: frogAsBigIntArray[8].toString(),
    ownerSemaphoreId: frogAsBigIntArray[9].toString(),
    reservedField1: frogAsBigIntArray[10].toString(),
    reservedField2: frogAsBigIntArray[11].toString(),
    reservedField3: frogAsBigIntArray[12].toString(),

    // Frog signature fields
    frogSignerPubkeyAx: hexToBigInt(signerPubKey[0]).toString(),
    frogSignerPubkeyAy: hexToBigInt(signerPubKey[1]).toString(),
    frogSignatureR8x: eddsa.F.toObject(rawSig.R8[0]).toString(),
    frogSignatureR8y: eddsa.F.toObject(rawSig.R8[1]).toString(),
    frogSignatureS: rawSig.S.toString(),

    // Owner identity secret
    semaphoreIdentityNullifier: identityPCD.claim.identity
      .getNullifier()
      .toString(),
    semaphoreIdentityTrapdoor: identityPCD.claim.identity
      .getTrapdoor()
      .toString(),

    externalNullifier: externalNullifer,
    watermark: watermark
  } as Record<string, `${number}` | `${number}`[]>;
}

function claimFromProofResult(
  frogPCD: EdDSAFrogPCD,
  publicSignals: string[]
): ZKEdDSAFrogPCDClaim {
  const frogOmitOwner: Omit<IFrogData, "ownerSemaphoreId"> = {
    name: frogPCD.claim.data.name,
    description: frogPCD.claim.data.description,
    imageUrl: frogPCD.claim.data.imageUrl,

    // Outputs appear in public signals first
    frogId: parseInt(publicSignals[1]),
    biome: parseInt(publicSignals[2]),
    rarity: parseInt(publicSignals[3]),
    temperament: parseInt(publicSignals[4]),
    jump: parseInt(publicSignals[5]),
    speed: parseInt(publicSignals[6]),
    intelligence: parseInt(publicSignals[7]),
    beauty: parseInt(publicSignals[8]),
    timestampSigned: parseInt(publicSignals[9])
  };

  return {
    frogOmitOwner,
    signerPublicKey: [publicSignals[13], publicSignals[14]],
    externalNullifier: publicSignals[15],
    watermark: publicSignals[16],
    nullifierHash: publicSignals[0],
  };
}

/**
 * Creates a new ZKEdDSAFrogPCD.
 */
export async function prove(
  args: ZKEdDSAFrogPCDArgs
): Promise<ZKEdDSAFrogPCD> {
  if (!initArgs) {
    throw new Error(
      "cannot make proof: init has not been called yet"
    );
  }

  await ensureEddsaInitialized();

  const { frogPCD, identityPCD, externalNullifier, watermark } = await checkProveInputs(args);

  const snarkInput = snarkInputForProof(
    frogPCD,
    identityPCD,
    externalNullifier,
    watermark.toString()
  )

  const { proof, publicSignals } = await groth16Prove(
    snarkInput,
    initArgs.wasmFilePath,
    initArgs.zkeyFilePath
  );

  const claim = claimFromProofResult(
    frogPCD,
    publicSignals
  );

  return new ZKEdDSAFrogPCD(uuid(), claim, proof);
}

/**
 * Verify the claims and proof of a ZKEdDSAFrogPCD.
 */
export async function verify(pcd: ZKEdDSAFrogPCD): Promise<boolean> {
  // verify() requires dependencies but not artifacts (verification key
  // is available in code as vkey imported above), so doesn't require
  // full package initialization.

  const t = pcd.claim.frogOmitOwner;
  // Outputs appear in public signals first
  const publicSignals = [
      pcd.claim.nullifierHash,
      t.frogId?.toString() || "0",
      t.biome?.toString() || "0",
      t.rarity?.toString() || "0",
      t.temperament?.toString() || "0",
      t.jump?.toString() || "0",
      t.speed?.toString() || "0",
      t.intelligence?.toString() || "0",
      t.beauty?.toString() || "0",
      t.timestampSigned?.toString() || "0",
      "0",
      "0",
      "0",
      pcd.claim.signerPublicKey[0],
      pcd.claim.signerPublicKey[1],
      pcd.claim.externalNullifier,
      pcd.claim.watermark
    ];
  return groth16Verify(vkey, { publicSignals, proof: pcd.proof });
}

/**
 * Serialize an {@link ZKEdDSAFrogPCD}.
 */
export async function serialize(
  pcd: ZKEdDSAFrogPCD
): Promise<SerializedPCD<ZKEdDSAFrogPCD>> {
  return {
    type: ZKEdDSAFrogPCDTypeName,
    pcd: JSONBig({ useNativeBigInt: true }).stringify(pcd)
  } as SerializedPCD<ZKEdDSAFrogPCD>;
}

/**
 * Deserializes a serialized {@link ZKEdDSAFrogPCD}.
 */
export async function deserialize(
  serialized: string
): Promise<ZKEdDSAFrogPCD> {
  const { id, claim, proof } = JSONBig({ useNativeBigInt: true }).parse(
    serialized
  );

  requireDefinedParameter(id, "id");
  requireDefinedParameter(claim, "claim");
  requireDefinedParameter(proof, "proof");

  return new ZKEdDSAFrogPCD(id, claim, proof);
}

/**
 * Get display options for a ZKEdDSAFrogPCD.
 */
export function getDisplayOptions(pcd: ZKEdDSAFrogPCD): DisplayOptions {
  return {
    header: "ZK EdDSA Frog PCD",
    displayName: "zk-eddsa-frog-" + pcd.id.substring(0, 4)
  };
}

/**
 * Returns true if a PCD is an ZK EdDSA Frog PCD, or false otherwise.
 */
export function isZKEdDSAFrogPCD(
  pcd: PCD
): pcd is ZKEdDSAFrogPCD {
  return pcd.type === ZKEdDSAFrogPCDTypeName;
}

/**
 * A PCD representing a proof of ownership of an EdDSA-signed frog.
 * The prover is able to prove ownership of a frog corresponding to their
 * semaphore identity, and keep their identity private.
 * The proof can also include a nullifier.
 */
export const ZKEdDSAFrogPCDPackage: PCDPackage<
  ZKEdDSAFrogPCDClaim,
  Groth16Proof,
  ZKEdDSAFrogPCDArgs,
  ZKEdDSAFrogPCDInitArgs
> = {
  name: ZKEdDSAFrogPCDTypeName,
  getDisplayOptions,
  renderCardBody: ZKEdDSAFrogCardBody,
  init,
  getProveDisplayOptions,
  prove,
  verify,
  serialize,
  deserialize
};
