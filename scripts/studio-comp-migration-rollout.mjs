#!/usr/bin/env node

import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import readline from "node:readline/promises";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = path.resolve(SCRIPT_DIR, "..");
const DEFAULT_COMMAND_TIMEOUT_MS = 60_000;
const APPLY_APPROVAL_AUTHOR_LOGIN = "ronchak";
const APPLY_APPROVAL_AUTHOR_ASSOCIATION = "OWNER";

export const ROLLOUT = Object.freeze({
  cliVersion: "2.95.4",
  stagingRef: "nxgsektqsgrtyfhawxbc",
  productionRef: "mimguepumzsgmcaycdsh",
  baselineMigrationCount: 100,
  preHistory: "100:359058cc127e57a47e429f6271453acf",
  intermediateMigrationCount: 101,
  recoveryMigrationCount: 102,
  convergenceMigrationCount: 103,
  attestedMigrationCount: 104,
  returnAttestedMigrationCount: 105,
  retainedMigrationCount: 106,
  criticalMigrationCount: 107,
  columnAttestedMigrationCount: 108,
  trialLockedMigrationCount: 109,
  staffIdentityMigrationCount: 110,
  restoredV22MigrationCount: 115,
  canonicalV23MigrationCount: 116,
  v24MigrationCount: 117,
  scheduleV25MigrationCount: 119,
  v25MigrationCount: 120,
  v26MigrationCount: 121,
  v27MigrationCount: 122,
  v28MigrationCount: 123,
  v29MigrationCount: 124,
  v30MigrationCount: 125,
  v31MigrationCount: 126,
  v32MigrationCount: 127,
  v33MigrationCount: 128,
  v34MigrationCount: 129,
  v35MigrationCount: 130,
  finalMigrationCount: 131,
  finalMigrationVersion: "20260831054918",
  releasePendingVersions: Object.freeze([
    "20260814043325",
    "20260814103046",
    "20260814105424",
    "20260814114500",
    "20260814152000",
    "20260814170000",
    "20260814183000",
    "20260814200000",
    "20260814213000",
    "20260815220402",
    "20260816012723",
    "20260820012533",
    "20260820025759",
    "20260820060216",
    "20260822193000",
    "20260823193155",
    "20260824190500",
    "20260825042838",
    "20260825043911",
    "20260826030234",
    "20260826030249",
    "20260826051527",
    "20260826073728",
    "20260826102840",
    "20260826155911",
    "20260826185651",
    "20260830065627",
    "20260830082610",
    "20260830151714",
    "20260831022021",
    "20260831054918",
  ]),
  finalPendingVersions: Object.freeze([
    "20260727100000",
    "20260727110000",
    "20260801050957",
    "20260801060000",
    "20260801070000",
    "20260801080000",
    "20260801090000",
    "20260801091000",
    "20260801092000",
    "20260801093000",
    "20260801094000",
    "20260801105313",
    "20260801112153",
    "20260801115044",
    "20260801123112",
    "20260801131844",
    "20260814043325",
    "20260814103046",
    "20260814105424",
    "20260814114500",
    "20260814152000",
    "20260814170000",
    "20260814183000",
    "20260814200000",
    "20260814213000",
    "20260815220402",
    "20260816012723",
    "20260820012533",
    "20260820025759",
    "20260820060216",
    "20260822193000",
    "20260823193155",
    "20260824190500",
    "20260825042838",
    "20260825043911",
    "20260826030234",
    "20260826030249",
    "20260826051527",
    "20260826073728",
    "20260826102840",
    "20260826155911",
    "20260826185651",
    "20260830065627",
    "20260830082610",
    "20260830151714",
    "20260831022021",
    "20260831054918",
  ]),
  requiredAncestry: Object.freeze([
    "d12f5b8cb7fabf82383227a0e5d41113d32ff928",
    "a615bdfc9755b6c3e611e9f8829fdaf387b4f981",
    "0294fdbd2eecc72a8204222c244b7874fe35ada4",
    "accbb1f9c1bc87fa511f3c2bcafb9aeebafa33e2",
    "d0c5159dd4ce7bf3ca9a126fa39577959e7ba15a",
    "8fc0cdd74466cd0e4292c0e94a84d682c8748010",
    "413b29d911eb98a6b6372469f1c3edf83ec545ee",
  ]),
  migrations: Object.freeze([
    Object.freeze({
      filename: "20260727100000_atomic_studio_comp_management.sql",
      sha256: "2cd1e15dbe5a8224a0e4829bc92c6b01aae4699006d603d613d18cb4bc82c5c6",
    }),
    Object.freeze({
      filename: "20260727110000_order_billing_events_after_studio_comps.sql",
      sha256: "22faa79522ba2018780fb260401cd23830df553ee3faf0546b2af689eb51bfc0",
    }),
  ]),
  scheduleMigrations: Object.freeze([
    Object.freeze({
      filename: "20260825042838_schedule_window_read_rpc.sql",
      sha256: "6e36b37902564eeb4eb54c9284615e80bbf44582cce864514db2060565092313",
    }),
    Object.freeze({
      filename: "20260825043911_attest_schedule_window_release.sql",
      sha256: "22637698a5af2043b74ed344c16ab111a27d83b54b1621a82deb091f436174f5",
    }),
  ]),
});

export const EXPECTED_OPERATIONAL_MANIFEST =
  "80bdb96e7109d28c632d131efe5ce9480912f18daa85f9816a8c007e40bc91f7";
export const EXPECTED_RESTORED_OPERATIONAL_MANIFEST =
  "298136123c4cef38f64f432cf410598615927d62b79b8ff6579228ee9f4f64d0";
export const EXPECTED_V27_OPERATIONAL_MANIFEST =
  "8694f564fc8a94a6230e54fe70e12e376502b0372b629339acad38c3a90178c1";
export const EXPECTED_RESTORED_V27_OPERATIONAL_MANIFEST =
  "988cbdeb2e5ee2e022484b15c8483bec215c5c5dbb32aaf0342b54ec33d677d9";
export const EXPECTED_COMBINED_RESTORED_V27_OPERATIONAL_MANIFEST =
  "a39c7435974be19b4a5f41d5a536402a16b429ec6d5ae1f9b8df81d95921ac91";
export const EXPECTED_COMBINED_RESTORED_V26_OPERATIONAL_MANIFEST =
  "56427ffe9f6a644af9c2b7100ee7060d93b84b3f1548d74cf3346a92be26c6bc";
export const EXPECTED_V29_TRANSITION_MANIFEST =
  "0:118b8031e9393f0114f486d0704e71475099d326f7fba9ad5d7518ad5a6a2c60";
export const EXPECTED_V29_OPERATIONAL_CONTRACT =
  "0:e2c4f27b967c5bff881a00e51416691ef752cc51e8298fb2142c96f607e4e1d0";
export const EXPECTED_V29_OPERATIONAL_MANIFEST =
  "e9034c1e146f58baea795e16ea93c6eca75fa463e0ee057eada0e09a784248c6";
export const EXPECTED_V30_REPLAY_REPAIRS_MANIFEST =
  "0:bf7208ee6b49620e3ef146812c6e69fa8bc73058086d6d7df12c91ec41888f55";
export const EXPECTED_V30_OPERATIONAL_CONTRACT =
  "0:6396d71a8da8966ca50d412e6d5caccb7dc624775e69aef993b61e303f5d0400";
export const EXPECTED_V30_OPERATIONAL_MANIFEST =
  "f0fcffe6a705b1d66df0e1c87ae04fb92070b2ed4308da354979a46e47087460";
export const EXPECTED_V30_COMPAT_V29_OPERATIONAL_CONTRACT =
  "0:982fdf3857f160204c92badb9d7cd5269eadef78238fbe9e2cd6f8cd7729a692";
export const EXPECTED_V30_PREDECESSOR_OPERATIONAL_MANIFEST =
  "32107329f69000537b2e8167d12674a90f46a7a7c8978149b70b8dac5edc7e17";
export const EXPECTED_V30_LEGACY_OPERATIONAL_MANIFEST =
  "86c290c86aa2eaf480d0f98ff58ac16bdf257d0d38e25cf273e05f3d0e05f830";
export const EXPECTED_V30_RESTORED_LEGACY_OPERATIONAL_MANIFEST =
  "b1b7b4d041878aaa9a2a33ee530376ac906f5e6f4cea0a5d001516c99273e91b";
export const EXPECTED_V31_RESOURCE_OWNERSHIP_MANIFEST =
  "0:7003a83b5deea53d0c365ec3e2eca4dd5281f7658fe0a41d053c1e1618d709c1";
export const EXPECTED_V31_OPERATIONAL_CONTRACT =
  "0:b0bf5a376dab5ece5a6d9e44b7ea3067ce7700200361c20f0b1f0166395f0c3b";
export const EXPECTED_V31_OPERATIONAL_MANIFEST =
  "26373f66ff1800369b7bad388a1b38452e48615b2635cc796d173a3fa92707fc";
export const EXPECTED_V31_PREDECESSOR_OPERATIONAL_MANIFEST =
  "eaead9e1d0d5696089de8a5c4e65dba15d6ba6b7e7fd47f8f911356bdc94420d";
export const EXPECTED_V31_COMPAT_V29_TRANSITION_MANIFEST =
  "0:cd76e49d09fafc55bd0caae3af64d1414114e8252c575aeda517093682fc4ab8";
export const EXPECTED_V31_COMPAT_V29_OPERATIONAL_CONTRACT =
  "0:8423e3fc0ba0d8e7ee9e5a9625f6078ca82f1998a766eb007c6d6433993e389a";
export const EXPECTED_V31_COMPAT_V29_OPERATIONAL_MANIFEST =
  "0ba8b407147eebbf0856c8b459507aeec5c927f37beff2ce1aefaceee6fb7711";
export const EXPECTED_V31_COMPAT_V30_REPLAY_REPAIRS_MANIFEST =
  "0:2eeb4d321d949b1d0bc76b5c94d6e51bd516511d9ff63baaee09081625ef4635";
export const EXPECTED_V31_COMPAT_V30_OPERATIONAL_CONTRACT =
  "0:48b8eff3f5470913614927bb0699970ea165a5ca5b5704cd73af08a9ec7dcdbb";
export const EXPECTED_V33_RESOURCE_OWNERSHIP_MANIFEST="0:9a3686c65b3709c76adddbef693fe67d9e33d9f38295f73b1e4faaa5534ab67a";
export const EXPECTED_V33_OPERATIONAL_CONTRACT_V31="0:fc3b9de6660335ddaeda6100978f7bb313f01fe2a564efa3167394a54a27c476";
export const EXPECTED_V33_OPERATIONAL_MANIFEST_V12="7982677386a8df84dee019036a51b3f71952a03de147ceefc2d05f6503220a5a";
export const EXPECTED_V33_EXPECTATION_STATE="1:4d0fb96027887d963e5c6f7476ab8496882792c8bb9aacac95db2a77b05bf312";
export const EXPECTED_V33_COMPAT_V29_TRANSITION_MANIFEST=EXPECTED_V31_COMPAT_V29_TRANSITION_MANIFEST;
export const EXPECTED_V33_COMPAT_V29_OPERATIONAL_CONTRACT="0:33a270e015c8a73824d38785b1bb7b8fde7ea67ee2783832042f335627d64864";
export const EXPECTED_V33_COMPAT_V29_OPERATIONAL_MANIFEST=EXPECTED_V31_COMPAT_V29_OPERATIONAL_MANIFEST;
export const EXPECTED_V33_COMPAT_V30_REPLAY_REPAIRS_MANIFEST=EXPECTED_V31_COMPAT_V30_REPLAY_REPAIRS_MANIFEST;
export const EXPECTED_V33_COMPAT_V30_OPERATIONAL_CONTRACT="0:12a3aea5cdfd8360926300447e0643c20b771c2ed7fa212676dbea3fbba5e905";
export const EXPECTED_V33_PREDECESSOR_OPERATIONAL_MANIFEST="076e54d2ff5bf99ea77518a94ba88dec06bcf1f5bd472439234e8e849652f5e1";
export const EXPECTED_V34_COMPAT_V29_TRANSITION_MANIFEST=
  EXPECTED_V33_COMPAT_V29_TRANSITION_MANIFEST;
export const EXPECTED_V34_COMPAT_V29_OPERATIONAL_CONTRACT=
  "0:5d022e3d25e3c09fd56cc80fd26ed8e6233b5ce881ddcc60b6b8593d8801190a";
export const EXPECTED_V34_COMPAT_V29_OPERATIONAL_MANIFEST=
  "a1f100a662af004ba6683ae15f0f9834493013131142612721a5b6d410971a3f";
export const EXPECTED_V34_COMPAT_V30_REPLAY_REPAIRS_MANIFEST=
  "0:508a8a5206cf3561197bf0395e5b700a1d5d2f54aae921c34ced795324643b98";
export const EXPECTED_V34_COMPAT_V30_OPERATIONAL_CONTRACT=
  EXPECTED_V33_COMPAT_V30_OPERATIONAL_CONTRACT;
export const EXPECTED_V34_PREDECESSOR_OPERATIONAL_MANIFEST=
  EXPECTED_V33_PREDECESSOR_OPERATIONAL_MANIFEST;
export const EXPECTED_V34_EXPECTATION_STATE=
  "1:98b3c2abb6dbe454ea0b9d84d3bdd31769f47b4fe72af9a5dcd5df476a62e443";
export const EXPECTED_V34_RESOURCE_OWNERSHIP_MANIFEST=
  EXPECTED_V33_RESOURCE_OWNERSHIP_MANIFEST;
export const EXPECTED_V34_OPERATIONAL_CONTRACT_V31=
  EXPECTED_V33_OPERATIONAL_CONTRACT_V31;
export const EXPECTED_V34_OPERATIONAL_MANIFEST_V12=
  EXPECTED_V33_OPERATIONAL_MANIFEST_V12;
export const EXPECTED_V36_COMPAT_V29_OPERATIONAL_CONTRACT=
  "0:1abbf21f66bcd927d0c1adf1f16255f4d4eebd030b0685f6dd3a2891d5afb5b9";
export const EXPECTED_V36_COMPAT_V29_OPERATIONAL_MANIFEST=
  "4f6e364fe37e1325f47e098a810daacc53175b68cb01ed5bda74103f567805c5";
export const EXPECTED_V36_COMPAT_V30_OPERATIONAL_CONTRACT=
  "0:846135b52d0b7784290b8428b3c1533bc3c1fd47aa5117c009516f640db979d6";
export const EXPECTED_V36_RESOURCE_OWNERSHIP_MANIFEST=
  "0:1e2b5d81df07c4738b195f786427759efd992aa187921b182317e58185c5e566";
export const EXPECTED_V36_OPERATIONAL_CONTRACT_V31=
  "0:873f7ac7a8a0d52ffb92de8936f35c1fd2a07c1f52fe20f4b617140fc5fbccae";
export const EXPECTED_V36_OPERATIONAL_MANIFEST_V11=
  "e0e7bb51715afc4d656260a86a03f897f7f11650cef676f4dd52763daaadec61";
export const EXPECTED_V36_OPERATIONAL_MANIFEST_V12=
  "7d55d1237d279a3a9242ccbf4ce814d54fc7eca4348295f0a125f7e8d0c9e627";

export const EXPECTED_SCHEDULE_V25_OPERATIONAL_READINESS =
  "true|119|20260825043911|" +
  ROLLOUT.finalPendingVersions.slice(0, -12).join(",") +
  "|0||release-db-attestation-v25";
export const EXPECTED_SCHEDULE_WINDOW_MANIFEST =
  "0:f4c66d3098dcb3210ac6cc92e1831eebaf9f2ed74b210e84ec773cb1d8e854a7";
export const EXPECTED_SCHEDULE_V25_CATALOG_STATE =
  "column_acls=205:32ad7f660d40de1c75de0e9d50e4c23f3588124e67f3665159f8f2f027617414:0;" +
  "columns=43:c2f9560d4d2d9742f22edeeb3386b2fce9def1e90290e7986f406d9f7dd0451b:0;" +
  "constraints=24:d8ae028684234bb1c69447c97e87fc8561ce18f03b7ec10f81a880ba5d813c5c:0;" +
  "functions=71:b2538a24f0a41982b21eeaaef6202f7df1809e46513d051ccb1c8e1301dc04a2:0;" +
  "indexes=12:c78635a18852d4cbe8be1bc34861848ba904b06639038c292f84d56ca7be50a7:0;" +
  "policies=16:259cc99c295d80442450cea438a462efd44748f2ace47456fca13133b52d17b8:0;" +
  "scoped_constraints=149:a1555af1e8eacb8f03b04c2109dc6966293705307d737e5601996cf81acc06b9:0;" +
  "scoped_indexes=33:4d401ee4a7e7f104957cb8cc84ad45164d57938ced0c2609259310aa980895f2:0;" +
  "sequences=3:27451af3027130cfb193bd4eb9f59221773a89e46bcb855a7a809df1b54a7574:0;" +
  "table_acls=14:d71f968d375333515659bd0220224c127cee6e7b3878f9ae36427f7c1561c92c:0;" +
  "tables=12:f56508ae1d3c712e7b239a1fe965adf88cec4e7f41f8d6b6db9ffce95f1bb76b:0;" +
  "triggers=12:61039a9e58e55b3aba5e7e2a40088fd492352560123bc5df30c7966cfd6d9efc:0";

export const EXPECTED_V34_OPERATIONAL_READINESS =
  "true|129|20260830151714|" +
  ROLLOUT.finalPendingVersions.slice(0, -2).join(",") +
  "|0||release-db-attestation-v34";
export const EXPECTED_OPERATIONAL_READINESS =
  "true|131|20260831054918|" + ROLLOUT.finalPendingVersions.join(",") +
  "|0||release-db-attestation-v36";
export const EXPECTED_V35_OPERATIONAL_READINESS =
  "true|130|20260831022021|" +
  ROLLOUT.finalPendingVersions.slice(0, -1).join(",") +
  "|0||release-db-attestation-v35";
export const EXPECTED_V36_RECOVERY_MANIFEST =
  "0:455520fff5182b12b23368da1afe60e133a01b78913fada73e8a708b94ae8dbb";
export const EXPECTED_V35_EVIDENCE_MANIFEST =
  "0:ab51017e560d5447369f72f9db4d7872012c59a91e9f385a7fc39e162ae1d45d";
export const EXPECTED_V32_OPERATIONAL_READINESS =
  "true|127|20260830065627|" +
  ROLLOUT.finalPendingVersions.slice(0, -4).join(",") +
  "|0||release-db-attestation-v32";
export const EXPECTED_V33_OPERATIONAL_READINESS =
  "true|128|20260830082610|" +
  ROLLOUT.finalPendingVersions.slice(0, -3).join(",") +
  "|0||release-db-attestation-v33";
export const EXPECTED_V31_OPERATIONAL_READINESS =
  "true|126|20260826185651|" +
  ROLLOUT.finalPendingVersions.slice(0, -5).join(",") +
  "|0||release-db-attestation-v31";

export const EXPECTED_V30_OPERATIONAL_READINESS =
  "true|125|20260826155911|" +
  ROLLOUT.finalPendingVersions.slice(0, -6).join(",") +
  "|0||release-db-attestation-v30";

export const EXPECTED_V29_OPERATIONAL_READINESS =
  "true|124|20260826102840|" +
  ROLLOUT.finalPendingVersions.slice(0, -7).join(",") +
  "|0||release-db-attestation-v29";

export const EXPECTED_V28_OPERATIONAL_READINESS =
  "true|123|20260826073728|" +
  ROLLOUT.finalPendingVersions.slice(0, -8).join(",") +
  "|0||release-db-attestation-v28";

export const EXPECTED_V27_OPERATIONAL_READINESS =
  "true|122|20260826051527|" +
  ROLLOUT.finalPendingVersions.slice(0, -9).join(",") +
  "|0||release-db-attestation-v27";

export const EXPECTED_V26_OPERATIONAL_READINESS =
  "true|121|20260826030249|" +
  ROLLOUT.finalPendingVersions.slice(0, -10).join(",") +
  "|0||release-db-attestation-v26";

export const EXPECTED_V25_OPERATIONAL_READINESS =
  "true|120|20260826030234|" +
  ROLLOUT.finalPendingVersions.slice(0, -11).join(",") +
  "|0||release-db-attestation-v25";

export const EXPECTED_V24_OPERATIONAL_READINESS =
  "true|117|20260824190500|" +
  ROLLOUT.finalPendingVersions.slice(0, -14).join(",") +
  "|0||release-db-attestation-v24";

export const EXPECTED_RESTORED_V22_OPERATIONAL_READINESS =
  "true|115|20260822193000|" +
  ROLLOUT.finalPendingVersions.slice(0, -16).join(",") +
  "|0||release-db-attestation-v22";

export const EXPECTED_CANONICAL_V23_OPERATIONAL_READINESS =
  "true|116|20260823193155|" +
  ROLLOUT.finalPendingVersions.slice(0, -15).join(",") +
  "|0||release-db-attestation-v23";

export const EXPECTED_RESTORED_V23_PENDING_V24_OPERATIONAL_READINESS =
  "false|116|20260823193155|" +
  ROLLOUT.finalPendingVersions.slice(0, -15).join(",") +
  "|1|operational_semantic_acl_manifest_v7|release-db-attestation-v23";

// Generated by the final migration against the actual PostgreSQL catalog and
// pinned to the exact zero-invalid-count archive authorization state.
export const EXPECTED_CRITICAL_SURFACE_MANIFEST =
  "0:31bec59b620eaa151c33cae2da08f533087e888216017247329e7cc517d98a0d";
export const EXPECTED_V27_CRITICAL_SURFACE_MANIFEST =
  "0:85921b516e77f025a3548356e70ade4d78a9bdc1635ec7713df4f883beb8709b";
export const EXPECTED_V26_CRITICAL_SURFACE_MANIFEST =
  "0:02e96ca8d2f4fe2117c2ab314fdab0ef079bac0a7c502c0cfcf2c3376529d620";

export const EXPECTED_TRIAL_LOCKED_OPERATIONAL_READINESS =
  `true|${ROLLOUT.trialLockedMigrationCount}|20260814213000|` +
  ROLLOUT.finalPendingVersions.slice(
    0,
    ROLLOUT.finalPendingVersions.length -
      (ROLLOUT.finalMigrationCount - ROLLOUT.trialLockedMigrationCount),
  ).join(",") +
  "|0||release-db-attestation-v16";

export const EXPECTED_STAFF_IDENTITY_OPERATIONAL_READINESS =
  `true|${ROLLOUT.staffIdentityMigrationCount}|20260815220402|` +
  ROLLOUT.finalPendingVersions.slice(
    0,
    -(ROLLOUT.finalMigrationCount - ROLLOUT.staffIdentityMigrationCount),
  ).join(",") +
  "|0||release-db-attestation-v17";

export const EXPECTED_RETURN_ATTESTED_OPERATIONAL_READINESS =
  "true|105|20260814152000|" +
  ROLLOUT.finalPendingVersions.slice(0, -16).join(",") +
  "|0||release-db-attestation-v12";

export const EXPECTED_RETAINED_OPERATIONAL_READINESS =
  "true|106|20260814170000|" +
  ROLLOUT.finalPendingVersions.slice(0, -15).join(",") +
  "|0||release-db-attestation-v13";

export const EXPECTED_CRITICAL_OPERATIONAL_READINESS =
  "true|107|20260814183000|" +
  ROLLOUT.finalPendingVersions.slice(0, -14).join(",") +
  "|0||release-db-attestation-v14";

export const EXPECTED_COLUMN_ATTESTED_OPERATIONAL_READINESS =
  "true|108|20260814200000|" +
  ROLLOUT.finalPendingVersions.slice(0, -13).join(",") +
  "|0||release-db-attestation-v15";

export const EXPECTED_ATTESTED_OPERATIONAL_READINESS =
  "true|104|20260814114500|" +
  ROLLOUT.finalPendingVersions.slice(0, -17).join(",") +
  "|0||release-db-attestation-v11";

export const EXPECTED_RECOVERY_OPERATIONAL_READINESS = Object.freeze([
  "true|102|20260814103046|" +
  ROLLOUT.finalPendingVersions.slice(0, -19).join(",") +
  "|0||release-db-attestation-v9",
]);

export const EXPECTED_CONVERGENCE_OPERATIONAL_READINESS =
  "true|103|20260814105424|" +
  ROLLOUT.finalPendingVersions.slice(0, -18).join(",") +
  "|0||release-db-attestation-v10";

export const EXPECTED_INTERMEDIATE_OPERATIONAL_READINESS =
  "true|101|20260814043325|" +
  ROLLOUT.finalPendingVersions.slice(0, -20).join(",") +
  "|0||release-db-attestation-v8";

export const EXPECTED_PRE_OPERATIONAL_READINESS =
  "true|100|20260801131844|" +
  ROLLOUT.finalPendingVersions.slice(0, -21).join(",") +
  "|0||release-db-attestation-v7";

export const EXPECTED_CATALOG_STATE =
  "column_acls=207:3aaaef1edbaee272791f8562946c774eba3d4623fdea1389b28576e15eff6ba7:0;" +
  "columns=43:c2f9560d4d2d9742f22edeeb3386b2fce9def1e90290e7986f406d9f7dd0451b:0;" +
  "constraints=24:d8ae028684234bb1c69447c97e87fc8561ce18f03b7ec10f81a880ba5d813c5c:0;" +
  "functions=78:d5fb12bc3b0dda48f847caa59807eb2b50d504c11df4572eaba1bec8d34d5648:0;" +
  "indexes=12:c78635a18852d4cbe8be1bc34861848ba904b06639038c292f84d56ca7be50a7:0;" +
  "policies=16:259cc99c295d80442450cea438a462efd44748f2ace47456fca13133b52d17b8:0;" +
  "scoped_constraints=152:6b4e905adf438acdbd688d00509bf0d95e4935ebfbfd35655fefee95bfbc1fdd:0;" +
  "scoped_indexes=34:752cd3247779f6123aa1fdfa4b57cb8188b5ee037677188b76d337b95488fef1:0;" +
  "sequences=3:27451af3027130cfb193bd4eb9f59221773a89e46bcb855a7a809df1b54a7574:0;" +
  "table_acls=15:833a397e5d1468003a459b22bf0852bee16a4a2624523ace30d16acfa3a75e2f:0;" +
  "tables=13:384ba5461ea17ff6c15c8a1fe97fb091508744399cc3fb812253fc85fbcf5246:0;" +
  "triggers=12:61039a9e58e55b3aba5e7e2a40088fd492352560123bc5df30c7966cfd6d9efc:0";

export const EXPECTED_RESTORED_CATALOG_STATE =
  "column_acls=207:3aaaef1edbaee272791f8562946c774eba3d4623fdea1389b28576e15eff6ba7:0;" +
  "columns=43:c2f9560d4d2d9742f22edeeb3386b2fce9def1e90290e7986f406d9f7dd0451b:0;" +
  "constraints=24:d8ae028684234bb1c69447c97e87fc8561ce18f03b7ec10f81a880ba5d813c5c:0;" +
  "functions=78:570325ae2bd7d236fa1371df924d66fdd81aaff03361970a110aa9c7184d1b4d:0;" +
  "indexes=12:c78635a18852d4cbe8be1bc34861848ba904b06639038c292f84d56ca7be50a7:0;" +
  "policies=16:259cc99c295d80442450cea438a462efd44748f2ace47456fca13133b52d17b8:0;" +
  "scoped_constraints=152:5d62445fa4493ddc15012262489509aa07b49f17c244e7aa693b32aad3f02f64:0;" +
  "scoped_indexes=34:752cd3247779f6123aa1fdfa4b57cb8188b5ee037677188b76d337b95488fef1:0;" +
  "sequences=3:27451af3027130cfb193bd4eb9f59221773a89e46bcb855a7a809df1b54a7574:0;" +
  "table_acls=15:833a397e5d1468003a459b22bf0852bee16a4a2624523ace30d16acfa3a75e2f:0;" +
  "tables=13:384ba5461ea17ff6c15c8a1fe97fb091508744399cc3fb812253fc85fbcf5246:0;" +
  "triggers=12:61039a9e58e55b3aba5e7e2a40088fd492352560123bc5df30c7966cfd6d9efc:0";

export const EXPECTED_V27_RESTORED_CATALOG_STATE =
  EXPECTED_RESTORED_CATALOG_STATE.replace(
    "functions=78:570325ae2bd7d236fa1371df924d66fdd81aaff03361970a110aa9c7184d1b4d:0",
    "functions=78:d5fb12bc3b0dda48f847caa59807eb2b50d504c11df4572eaba1bec8d34d5648:0",
  );
export const EXPECTED_V29_RESTORED_CATALOG_STATE =
  EXPECTED_V27_RESTORED_CATALOG_STATE;
export const EXPECTED_COMBINED_RESTORED_V26_CATALOG_STATE =
  "column_acls=207:3aaaef1edbaee272791f8562946c774eba3d4623fdea1389b28576e15eff6ba7:0;" +
  "columns=43:c2f9560d4d2d9742f22edeeb3386b2fce9def1e90290e7986f406d9f7dd0451b:0;" +
  "constraints=24:d8ae028684234bb1c69447c97e87fc8561ce18f03b7ec10f81a880ba5d813c5c:0;" +
  "functions=80:f6797e4022792d03bb7b71e6acb4f01622fac893da52e77366cda21fead79aa1:0;" +
  "indexes=12:c78635a18852d4cbe8be1bc34861848ba904b06639038c292f84d56ca7be50a7:0;" +
  "policies=16:259cc99c295d80442450cea438a462efd44748f2ace47456fca13133b52d17b8:0;" +
  "scoped_constraints=152:5d62445fa4493ddc15012262489509aa07b49f17c244e7aa693b32aad3f02f64:0;" +
  "scoped_indexes=34:752cd3247779f6123aa1fdfa4b57cb8188b5ee037677188b76d337b95488fef1:0;" +
  "sequences=3:27451af3027130cfb193bd4eb9f59221773a89e46bcb855a7a809df1b54a7574:0;" +
  "table_acls=15:833a397e5d1468003a459b22bf0852bee16a4a2624523ace30d16acfa3a75e2f:0;" +
  "tables=13:384ba5461ea17ff6c15c8a1fe97fb091508744399cc3fb812253fc85fbcf5246:0;" +
  "triggers=12:61039a9e58e55b3aba5e7e2a40088fd492352560123bc5df30c7966cfd6d9efc:0";
export const EXPECTED_V30_CATALOG_STATE =
  "column_acls=208:fc90b7848ec06d8f1ac9c95f8d13043d36e93d47f2266a5eb9b9fa08071ca875:0;" +
  "columns=44:e16cf54c60e5caf11f3e0d7feb1d576436c4e5ca20ab6b1297ae8d61b63418ee:0;" +
  "constraints=25:a47a52be64bc4119f8905431c4af3bbd81728b61f40c75fa218fbeb02713e166:0;" +
  "functions=81:82f48404c2b73635d04d13c6fe4d7b2d0cf41f3366ead2ede72946fe04b33eec:0;" +
  "indexes=12:c78635a18852d4cbe8be1bc34861848ba904b06639038c292f84d56ca7be50a7:0;" +
  "policies=16:259cc99c295d80442450cea438a462efd44748f2ace47456fca13133b52d17b8:0;" +
  "scoped_constraints=153:b8a326a221f6c416a99b59216f328a32185e9d5a692d72517e82ffc2dbcaf31a:0;" +
  "scoped_indexes=34:752cd3247779f6123aa1fdfa4b57cb8188b5ee037677188b76d337b95488fef1:0;" +
  "sequences=3:27451af3027130cfb193bd4eb9f59221773a89e46bcb855a7a809df1b54a7574:0;" +
  "table_acls=15:833a397e5d1468003a459b22bf0852bee16a4a2624523ace30d16acfa3a75e2f:0;" +
  "tables=13:384ba5461ea17ff6c15c8a1fe97fb091508744399cc3fb812253fc85fbcf5246:0;" +
  "triggers=12:61039a9e58e55b3aba5e7e2a40088fd492352560123bc5df30c7966cfd6d9efc:0";
export const EXPECTED_V30_RESTORED_CATALOG_STATE =
  EXPECTED_V30_CATALOG_STATE.replace(
    "scoped_constraints=153:b8a326a221f6c416a99b59216f328a32185e9d5a692d72517e82ffc2dbcaf31a:0",
    "scoped_constraints=153:6f28d831e7c6194512c7180bcf8bf566c772b2f76c093ed3957f0422d2aca916:0",
  );
// Final V31 catalogs are pinned separately for canonical and V30-dump restore
// paths because PostgreSQL preserves different historical constraint identities.
export const EXPECTED_V31_CATALOG_STATE =
  "column_acls=228:44119eb2d0f6a6f4d130b4353519eb478e6e830791ccef778e4c261e705269fc:0;" +
  "columns=44:e16cf54c60e5caf11f3e0d7feb1d576436c4e5ca20ab6b1297ae8d61b63418ee:0;" +
  "constraints=25:a47a52be64bc4119f8905431c4af3bbd81728b61f40c75fa218fbeb02713e166:0;" +
  "functions=109:1acb912f850aee6f707540280e1c16f9e153da3284a1d2415315f5c93f383d98:0;" +
  "indexes=12:c78635a18852d4cbe8be1bc34861848ba904b06639038c292f84d56ca7be50a7:0;" +
  "policies=16:259cc99c295d80442450cea438a462efd44748f2ace47456fca13133b52d17b8:0;" +
  "scoped_constraints=176:f71ef6881d9692d2f8d59c7a55753aa7c637f72473fca97c8293ee6c640f7fdf:0;" +
  "scoped_indexes=40:2812d942667fd385ad0a409da343a92be4627c2c8efca3b251fd4fddeeb3244c:0;" +
  "sequences=3:27451af3027130cfb193bd4eb9f59221773a89e46bcb855a7a809df1b54a7574:0;" +
  "table_acls=21:fa3823b514d8c4a3cf0500cb2572da389655797ad781bd6c51b2eb169cfbf472:0;" +
  "tables=18:1d850078f0f5785becf0be5be1e3b0b0810551c89af5feda2d11a5d25c48058d:0;" +
  "triggers=14:03a92971a8b66629aac9892448a2448e6844bfb7edd27c0c5448f17235e270e7:0";
export const EXPECTED_V31_RESTORED_CATALOG_STATE =
  "column_acls=228:44119eb2d0f6a6f4d130b4353519eb478e6e830791ccef778e4c261e705269fc:0;" +
  "columns=44:e16cf54c60e5caf11f3e0d7feb1d576436c4e5ca20ab6b1297ae8d61b63418ee:0;" +
  "constraints=25:a47a52be64bc4119f8905431c4af3bbd81728b61f40c75fa218fbeb02713e166:0;" +
  "functions=109:1acb912f850aee6f707540280e1c16f9e153da3284a1d2415315f5c93f383d98:0;" +
  "indexes=12:c78635a18852d4cbe8be1bc34861848ba904b06639038c292f84d56ca7be50a7:0;" +
  "policies=16:259cc99c295d80442450cea438a462efd44748f2ace47456fca13133b52d17b8:0;" +
  "scoped_constraints=176:66315b7b7d9fc49b9b0ab73171fcf0dbfa0c1c279c8668269cf637e5d2aa53b5:0;" +
  "scoped_indexes=40:2812d942667fd385ad0a409da343a92be4627c2c8efca3b251fd4fddeeb3244c:0;" +
  "sequences=3:27451af3027130cfb193bd4eb9f59221773a89e46bcb855a7a809df1b54a7574:0;" +
  "table_acls=21:fa3823b514d8c4a3cf0500cb2572da389655797ad781bd6c51b2eb169cfbf472:0;" +
  "tables=18:1d850078f0f5785becf0be5be1e3b0b0810551c89af5feda2d11a5d25c48058d:0;" +
  "triggers=14:03a92971a8b66629aac9892448a2448e6844bfb7edd27c0c5448f17235e270e7:0";
export const EXPECTED_V32_CATALOG_STATE = EXPECTED_V31_CATALOG_STATE.replace(
  "functions=109:1acb912f850aee6f707540280e1c16f9e153da3284a1d2415315f5c93f383d98:0",
  "functions=112:a1884a152c3ea103fbc07961b857dae737b65da23884ebbc2f3e31d940a50228:0",
);
export const EXPECTED_V32_RESTORED_CATALOG_STATE = EXPECTED_V32_CATALOG_STATE.replace(
  "scoped_constraints=176:f71ef6881d9692d2f8d59c7a55753aa7c637f72473fca97c8293ee6c640f7fdf:0",
  "scoped_constraints=176:66315b7b7d9fc49b9b0ab73171fcf0dbfa0c1c279c8668269cf637e5d2aa53b5:0",
);
export const EXPECTED_V33_CATALOG_STATE =
  "column_acls=248:6346e2caf6a983b58a2b22555157a65e8a951e4ec0746b622581229637e7aafc:0;" +
  "columns=44:e16cf54c60e5caf11f3e0d7feb1d576436c4e5ca20ab6b1297ae8d61b63418ee:0;" +
  "constraints=25:a47a52be64bc4119f8905431c4af3bbd81728b61f40c75fa218fbeb02713e166:0;" +
  "functions=123:7cef74e2116c650ecad76feb91d81e6c8fd68cc5dfeaeffa147ecc1999f59429:0;" +
  "indexes=12:c78635a18852d4cbe8be1bc34861848ba904b06639038c292f84d56ca7be50a7:0;" +
  "policies=16:259cc99c295d80442450cea438a462efd44748f2ace47456fca13133b52d17b8:0;" +
  "scoped_constraints=185:5c3c8f502fb9d108f0bcc571e1962dd70fe6a824f4c8fb68b755e5400b96e5ed:0;" +
  "scoped_indexes=43:860bc2db0eb34a7d7eb1e1f992c5a666f1fd91a3b01eee6ece091fd332df198f:0;" +
  "sequences=3:27451af3027130cfb193bd4eb9f59221773a89e46bcb855a7a809df1b54a7574:0;" +
  "table_acls=23:e6550095ad8418751243b9f47f2e1eb2c813a2128adf059d11237539a7b76c99:0;" +
  "tables=20:3bc9c3ac932f863270a2b0a5c100d6943e562943ffd5ab51e06420f25963bf4e:0;" +
  "triggers=14:03a92971a8b66629aac9892448a2448e6844bfb7edd27c0c5448f17235e270e7:0";
export const EXPECTED_V33_RESTORED_CATALOG_STATE=EXPECTED_V33_CATALOG_STATE.replace(
    "scoped_constraints=185:5c3c8f502fb9d108f0bcc571e1962dd70fe6a824f4c8fb68b755e5400b96e5ed:0",
    "scoped_constraints=185:e21f005cf7e9e856418d258efe7ebb5912a69e3182d1dd791d33bd5329567365:0",
  );
export const EXPECTED_V34_CATALOG_STATE = EXPECTED_V33_CATALOG_STATE.replace(
  "functions=123:7cef74e2116c650ecad76feb91d81e6c8fd68cc5dfeaeffa147ecc1999f59429:0",
  "functions=123:7ac91dbf39fb73a9938472d98906d19e8845f128f4e617bda0f95a70cc10ecad:0",
);
export const EXPECTED_V34_RESTORED_CATALOG_STATE = EXPECTED_V34_CATALOG_STATE.replace(
  "scoped_constraints=185:5c3c8f502fb9d108f0bcc571e1962dd70fe6a824f4c8fb68b755e5400b96e5ed:0",
  "scoped_constraints=185:e21f005cf7e9e856418d258efe7ebb5912a69e3182d1dd791d33bd5329567365:0",
);
export const EXPECTED_V35_CATALOG_STATE = EXPECTED_V34_CATALOG_STATE
  .replace(
    "column_acls=248:6346e2caf6a983b58a2b22555157a65e8a951e4ec0746b622581229637e7aafc:0",
    "column_acls=250:ff59f3e2ae56a6b3df6de1a82beb500b46164d72f96d7d093f17e2c14288c6a4:0",
  )
  .replace(
    "functions=123:7ac91dbf39fb73a9938472d98906d19e8845f128f4e617bda0f95a70cc10ecad:0",
    "functions=124:12c56ca33a56c4699c72bb449bd84d8762337e3ac9e9ea0744bea947113f8e35:0",
  )
  .replace(
    "scoped_constraints=185:5c3c8f502fb9d108f0bcc571e1962dd70fe6a824f4c8fb68b755e5400b96e5ed:0",
    "scoped_constraints=188:42f4f5780a30ac90b9245761dc77baefd7ab7c141ddf85702961aef7f0c35a95:0",
  )
  .replace(
    "scoped_indexes=43:860bc2db0eb34a7d7eb1e1f992c5a666f1fd91a3b01eee6ece091fd332df198f:0",
    "scoped_indexes=44:b32ce852dd6791534b0a3e150fd627e8e5c509ef5b107be1cf7d75a3a3f3040a:0",
  )
  .replace(
    "table_acls=23:e6550095ad8418751243b9f47f2e1eb2c813a2128adf059d11237539a7b76c99:0",
    "table_acls=24:e1b346d422bbc3780822ba8342e6f669cd668c1087a730891162222bc53778fe:0",
  )
  .replace(
    "tables=20:3bc9c3ac932f863270a2b0a5c100d6943e562943ffd5ab51e06420f25963bf4e:0",
    "tables=21:70cfffd8c0183dd386f0c135cfac36b540f769d8e237046352f3e56f9db35c5c:0",
  );
export const EXPECTED_V35_RESTORED_CATALOG_STATE = EXPECTED_V35_CATALOG_STATE.replace(
  "scoped_constraints=188:42f4f5780a30ac90b9245761dc77baefd7ab7c141ddf85702961aef7f0c35a95:0",
  "scoped_constraints=188:3c96f4bcea526e0df56adf94655b9f0c643108420603b2415cd886e4b703642e:0",
);
export const EXPECTED_V36_CATALOG_STATE = "column_acls=252:77ed54c37fb6a77a67823ac6a3c13e100fdfe9a15d417087eaa8335aca7984c4:0;columns=44:e16cf54c60e5caf11f3e0d7feb1d576436c4e5ca20ab6b1297ae8d61b63418ee:0;constraints=25:a47a52be64bc4119f8905431c4af3bbd81728b61f40c75fa218fbeb02713e166:0;functions=126:8c1c8c79d9f1bf06915fb5882e3044bd759ef7320638295763440f6057e311e4:0;indexes=12:c78635a18852d4cbe8be1bc34861848ba904b06639038c292f84d56ca7be50a7:0;policies=16:259cc99c295d80442450cea438a462efd44748f2ace47456fca13133b52d17b8:0;scoped_constraints=191:65957dcbf81ee2513bebb4600a68b328b62100fa015b8cb90e9a164f01bb8fe9:0;scoped_indexes=45:1bfef3f53dfb4665e9f438c66cc04baf062234ae4e47a66a1ae9b7c924c47486:0;sequences=3:27451af3027130cfb193bd4eb9f59221773a89e46bcb855a7a809df1b54a7574:0;table_acls=25:0b972e5cc9be4772e46edfdac6a45d9d6074c433df6cb139232028c9d637d06d:0;tables=22:d3352c35012f5c65edb3cf3b7c5b864f916357d6a11d732199fe30b04034962f:0;triggers=14:03a92971a8b66629aac9892448a2448e6844bfb7edd27c0c5448f17235e270e7:0";
export const EXPECTED_V36_RESTORED_CATALOG_STATE = "column_acls=252:77ed54c37fb6a77a67823ac6a3c13e100fdfe9a15d417087eaa8335aca7984c4:0;columns=44:e16cf54c60e5caf11f3e0d7feb1d576436c4e5ca20ab6b1297ae8d61b63418ee:0;constraints=25:a47a52be64bc4119f8905431c4af3bbd81728b61f40c75fa218fbeb02713e166:0;functions=126:8c1c8c79d9f1bf06915fb5882e3044bd759ef7320638295763440f6057e311e4:0;indexes=12:c78635a18852d4cbe8be1bc34861848ba904b06639038c292f84d56ca7be50a7:0;policies=16:259cc99c295d80442450cea438a462efd44748f2ace47456fca13133b52d17b8:0;scoped_constraints=191:ac1c5b8bd2202b318843d62691fec39501e3b58e2090447f8d7633b43dfdf3da:0;scoped_indexes=45:1bfef3f53dfb4665e9f438c66cc04baf062234ae4e47a66a1ae9b7c924c47486:0;sequences=3:27451af3027130cfb193bd4eb9f59221773a89e46bcb855a7a809df1b54a7574:0;table_acls=25:0b972e5cc9be4772e46edfdac6a45d9d6074c433df6cb139232028c9d637d06d:0;tables=22:d3352c35012f5c65edb3cf3b7c5b864f916357d6a11d732199fe30b04034962f:0;triggers=14:03a92971a8b66629aac9892448a2448e6844bfb7edd27c0c5448f17235e270e7:0";

export const EXPECTED_V26_EXPECTATION_STATE =
  "1:fb5e52ebe1cf068e8ac0e195852f12d7af2c2226883b37d49e1ddac670e9f66b";
export const EXPECTED_V27_COMPAT_V26_EXPECTATION_STATE =
  "1:266f6a74c45a44175d6224a85226a2ce903b0b0c1b53d2d7b8bc1f34959aa7a8";
export const EXPECTED_V27_EXPECTATION_STATE =
  "1:046ff943b7298d5ef3b624119ac7cf8e3a9402471c05c5385068b0954fa18008";
export const EXPECTED_V28_COMPAT_V27_EXPECTATION_STATE =
  "1:74da7c7a75b048163e208473d28cf32366ace36108e99abe21947d89449d7ce6";
export const EXPECTED_V28_EXPECTATION_STATE =
  "1:ffde05a120e904a830fb9a61cd610ca474522dadf933408b410c1985e836d202";
export const EXPECTED_V29_EXPECTATION_STATE =
  "1:7e003460a485f8125432d1c2c7087bc04f1a4037728aa4f16b22640daf2eb7c7";
export const EXPECTED_V30_COMPAT_V26_EXPECTATION_STATE =
  "1:000ddde23152ab5d5eb830fb5958ef1aa931acfa95a866acda6325bd3d6a273c";
export const EXPECTED_V30_COMPAT_V27_EXPECTATION_STATE =
  "1:6e4238353d10a453e3a4581ff8f63a8a0310b33d404be1c6d4e0a04d5c67aa4f";
export const EXPECTED_V30_COMPAT_V28_EXPECTATION_STATE =
  "1:e57560e15d366056bd249ecf52225162403b0866c4fea4929b34c8ef84c3df11";
export const EXPECTED_V30_COMPAT_V29_EXPECTATION_STATE =
  "1:b0e1d3777d1686ff48b9f5d73a255cc1f6d6fea974736215c7c21a621dbaa1a5";
export const EXPECTED_V30_EXPECTATION_STATE =
  "1:64daabcda5df9823fa4b32e7320e715d1d96dd0d0acc697ebed4570256655643";
export const EXPECTED_V31_EXPECTATION_STATE =
  "1:b20f61ed99dae99c64e82856b2a4ba563089f28945ae303ff8a78bef88af733a";
export const EXPECTED_V36_COMPAT_V27_EXPECTATION_STATE =
  "1:0978554adecf9b75eee1cca4864803a58869a42aea7ac3470110d918b4508723";
export const EXPECTED_V36_COMPAT_V28_EXPECTATION_STATE =
  "1:169ada27f60344b8127df5c1878572e76e0a6bb027483e7ec23460bdc0147740";
export const EXPECTED_V36_COMPAT_V29_EXPECTATION_STATE =
  "1:510556b6f40df9ab263f91f9e322baac37b63cfac487aaffd63ee60a16582129";
export const EXPECTED_V36_COMPAT_V30_EXPECTATION_STATE =
  "1:9ea31cfce65422d038c821449a11f49b826dd20daef71a09906403f1569ccffa";
export const EXPECTED_V36_EXPECTATION_STATE =
  "1:3d764f9527b71e81235d6ae5dbc62047149958b39b741d63e6600f3d78a4a587";

export function validateOperationalManifest(value) {
  if (
    value !== EXPECTED_OPERATIONAL_MANIFEST &&
    value !== EXPECTED_RESTORED_OPERATIONAL_MANIFEST &&
    value !== EXPECTED_V27_OPERATIONAL_MANIFEST &&
    value !== EXPECTED_RESTORED_V27_OPERATIONAL_MANIFEST &&
    value !== EXPECTED_COMBINED_RESTORED_V27_OPERATIONAL_MANIFEST &&
    value !== EXPECTED_COMBINED_RESTORED_V26_OPERATIONAL_MANIFEST &&
    value !== EXPECTED_V30_LEGACY_OPERATIONAL_MANIFEST &&
    value !== EXPECTED_V30_RESTORED_LEGACY_OPERATIONAL_MANIFEST
  ) {
    throw new RolloutError(`Operational semantic/ACL manifest mismatch: ${value}.`);
  }
  return value;
}

export function validateOperationalReadiness(value) {
  if (value !== EXPECTED_OPERATIONAL_READINESS) {
    throw new RolloutError("V31 operational readiness did not match the exact release state.");
  }
  return value;
}

export function validateV30OperationalReadiness(value) {
  if (value !== EXPECTED_V30_OPERATIONAL_READINESS) {
    throw new RolloutError("V30 operational readiness did not match the exact predecessor state.");
  }
  return value;
}

export function validateV29OperationalReadiness(value) {
  if (value !== EXPECTED_V29_OPERATIONAL_READINESS) {
    throw new RolloutError("V29 operational readiness did not match the exact predecessor state.");
  }
  return value;
}

export function validateV28OperationalReadiness(value) {
  if (value !== EXPECTED_V28_OPERATIONAL_READINESS) {
    throw new RolloutError("V28 operational readiness did not match the exact predecessor state.");
  }
  return value;
}

export function validateV29TransitionManifest(value) {
  if (value !== EXPECTED_V29_TRANSITION_MANIFEST) {
    throw new RolloutError("V29 enrollment transition manifest did not match the exact release state.");
  }
  return value;
}

export function validateV29OperationalContract(value) {
  if (value !== EXPECTED_V29_OPERATIONAL_CONTRACT) {
    throw new RolloutError("V29 operational contract did not match the exact release state.");
  }
  return value;
}

export function validateV29OperationalManifest(value) {
  if (value !== EXPECTED_V29_OPERATIONAL_MANIFEST) {
    throw new RolloutError("V29 operational manifest did not match the exact release state.");
  }
  return value;
}

export function validateV30ReplayRepairsManifest(value) {
  if (value !== EXPECTED_V30_REPLAY_REPAIRS_MANIFEST) {
    throw new RolloutError("V30 replay-repair manifest did not match the exact release state.");
  }
  return value;
}

export function validateV30OperationalContract(value) {
  if (value !== EXPECTED_V30_OPERATIONAL_CONTRACT) {
    throw new RolloutError("V30 operational contract did not match the exact release state.");
  }
  return value;
}

export function validateV30OperationalManifest(value) {
  if (value !== EXPECTED_V30_OPERATIONAL_MANIFEST) {
    throw new RolloutError("V30 operational manifest did not match the exact release state.");
  }
  return value;
}

export function validateV30CompatV29OperationalContract(value) {
  if (value !== EXPECTED_V30_COMPAT_V29_OPERATIONAL_CONTRACT) {
    throw new RolloutError("V30 compatibility V29 operational contract did not match the exact release state.");
  }
  return value;
}

export function validateV30PredecessorOperationalManifest(value) {
  if (value !== EXPECTED_V30_PREDECESSOR_OPERATIONAL_MANIFEST) {
    throw new RolloutError("V30 predecessor operational manifest did not match the exact release state.");
  }
  return value;
}

export function validateV31ResourceOwnershipManifest(value) {
  if (value !== EXPECTED_V31_RESOURCE_OWNERSHIP_MANIFEST) {
    throw new RolloutError("V31 resource-ownership manifest did not match the exact release state.");
  }
  return value;
}

export function validateV31OperationalContract(value) {
  if (value !== EXPECTED_V31_OPERATIONAL_CONTRACT) {
    throw new RolloutError("V31 operational contract did not match the exact release state.");
  }
  return value;
}

export function validateV31OperationalManifest(value) {
  if (value !== EXPECTED_V31_OPERATIONAL_MANIFEST) {
    throw new RolloutError("V31 operational manifest did not match the exact release state.");
  }
  return value;
}

export function validateV31PredecessorOperationalManifest(value) {
  if (value !== EXPECTED_V31_PREDECESSOR_OPERATIONAL_MANIFEST) {
    throw new RolloutError("V31 predecessor operational manifest did not match V30.");
  }
  return value;
}

export function validateV31CompatV29TransitionManifest(value) {
  if (value !== EXPECTED_V31_COMPAT_V29_TRANSITION_MANIFEST) {
    throw new RolloutError("V31 compatibility V29 transition manifest mismatch.");
  }
  return value;
}

export function validateV31CompatV29OperationalContract(value) {
  if (value !== EXPECTED_V31_COMPAT_V29_OPERATIONAL_CONTRACT) {
    throw new RolloutError("V31 compatibility V29 operational contract mismatch.");
  }
  return value;
}

export function validateV31CompatV29OperationalManifest(value) {
  if (value !== EXPECTED_V31_COMPAT_V29_OPERATIONAL_MANIFEST) {
    throw new RolloutError("V31 compatibility V29 operational manifest mismatch.");
  }
  return value;
}

export function validateV31CompatV30ReplayRepairsManifest(value) {
  if (value !== EXPECTED_V31_COMPAT_V30_REPLAY_REPAIRS_MANIFEST) {
    throw new RolloutError("V31 compatibility V30 replay-repair manifest mismatch.");
  }
  return value;
}

export function validateV31CompatV30OperationalContract(value) {
  if (value !== EXPECTED_V31_COMPAT_V30_OPERATIONAL_CONTRACT) {
    throw new RolloutError("V31 compatibility V30 operational contract mismatch.");
  }
  return value;
}

export function validateV27OperationalReadiness(value) {
  if (value !== EXPECTED_V27_OPERATIONAL_READINESS) {
    throw new RolloutError("V27 operational readiness did not match the exact predecessor state.");
  }
  return value;
}

export function validateV26OperationalReadiness(value) {
  if (value !== EXPECTED_V26_OPERATIONAL_READINESS) {
    throw new RolloutError("V26 operational readiness did not match the exact predecessor state.");
  }
  return value;
}

export function validateCriticalSurfaceManifest(value) {
  if (value !== EXPECTED_CRITICAL_SURFACE_MANIFEST) {
    throw new RolloutError(
      "V18 critical-surface semantic manifest did not match the exact archive authorization state.",
    );
  }
  return value;
}

export function validateV26CriticalSurfaceManifest(value) {
  if (value !== EXPECTED_V26_CRITICAL_SURFACE_MANIFEST) {
    throw new RolloutError("V26 critical-surface manifest did not match the predecessor state.");
  }
  return value;
}

export function validateV26ExpectationState(value) {
  if (value !== EXPECTED_V26_EXPECTATION_STATE) {
    throw new RolloutError(
      "V26 release expectation row did not match the exact pinned state.",
    );
  }
  return value;
}

export function validateV27CompatV26ExpectationState(value) {
  if (value !== EXPECTED_V27_COMPAT_V26_EXPECTATION_STATE) {
    throw new RolloutError("V27 compatibility V26 expectation row did not match the exact pinned state.");
  }
  return value;
}

export function validateV27ExpectationState(value) {
  if (value !== EXPECTED_V27_EXPECTATION_STATE) {
    throw new RolloutError("V27 release expectation row did not match the exact pinned state.");
  }
  return value;
}

export function validateV28CompatV27ExpectationState(value) {
  if (value !== EXPECTED_V28_COMPAT_V27_EXPECTATION_STATE) {
    throw new RolloutError("V28 compatibility V27 expectation row did not match the exact pinned state.");
  }
  return value;
}

export function validateV28ExpectationState(value) {
  if (value !== EXPECTED_V28_EXPECTATION_STATE) {
    throw new RolloutError("V28 release expectation row did not match the exact pinned state.");
  }
  return value;
}

export function validateV29ExpectationState(value) {
  if (value !== EXPECTED_V29_EXPECTATION_STATE) {
    throw new RolloutError("V29 release expectation row did not match the exact pinned state.");
  }
  return value;
}

export function validateV30ExpectationState(value) {
  if (value !== EXPECTED_V30_EXPECTATION_STATE) {
    throw new RolloutError("V30 expectation state did not match the exact release state.");
  }
  return value;
}

export function validateV31ExpectationState(value) {
  if (value !== EXPECTED_V31_EXPECTATION_STATE) {
    throw new RolloutError("V31 expectation state did not match the exact release state.");
  }
  return value;
}

export function validateV30CompatV28ExpectationState(value) {
  if (value !== EXPECTED_V30_COMPAT_V28_EXPECTATION_STATE) {
    throw new RolloutError("V30 compatibility V28 expectation state did not match the exact release state.");
  }
  return value;
}

export function validateV30CompatV26ExpectationState(value) {
  if (value !== EXPECTED_V30_COMPAT_V26_EXPECTATION_STATE) {
    throw new RolloutError("V30 compatibility V26 expectation state did not match the exact release state.");
  }
  return value;
}

export function validateV30CompatV27ExpectationState(value) {
  if (value !== EXPECTED_V30_COMPAT_V27_EXPECTATION_STATE) {
    throw new RolloutError("V30 compatibility V27 expectation state did not match the exact release state.");
  }
  return value;
}

export function validateV30CompatV29ExpectationState(value) {
  if (value !== EXPECTED_V30_COMPAT_V29_EXPECTATION_STATE) {
    throw new RolloutError("V30 compatibility V29 expectation state did not match the exact release state.");
  }
  return value;
}

export function validateV36CompatV27ExpectationState(value) {
  if (value !== EXPECTED_V36_COMPAT_V27_EXPECTATION_STATE) {
    throw new RolloutError("V36 compatibility V27 expectation state did not match the exact release state.");
  }
  return value;
}

export function validateV36CompatV28ExpectationState(value) {
  if (value !== EXPECTED_V36_COMPAT_V28_EXPECTATION_STATE) {
    throw new RolloutError("V36 compatibility V28 expectation state did not match the exact release state.");
  }
  return value;
}

export function validateV36CompatV29ExpectationState(value) {
  if (value !== EXPECTED_V36_COMPAT_V29_EXPECTATION_STATE) {
    throw new RolloutError("V36 compatibility V29 expectation state did not match the exact release state.");
  }
  return value;
}

export function validateV36CompatV30ExpectationState(value) {
  if (value !== EXPECTED_V36_COMPAT_V30_EXPECTATION_STATE) {
    throw new RolloutError("V36 compatibility V30 expectation state did not match the exact release state.");
  }
  return value;
}

export function validateV36ExpectationState(value) {
  if (value !== EXPECTED_V36_EXPECTATION_STATE) {
    throw new RolloutError("V36 expectation state did not match the exact release state.");
  }
  return value;
}

export const OPERATIONAL_READINESS_SQL = `
select ready::text || '|' || migration_count::text || '|' || migration_head || '|' ||
       array_to_string(pending_versions, ',') || '|' || cardinality(security_failures)::text || '|' ||
       coalesce(array_to_string(security_failures, ','), '') || '|' || manifest_version
  as operational_readiness
from public.koaryu_release_schema_preflight_v4()
`;

export const FINAL_OPERATIONAL_READINESS_SQL = `
select ready::text || '|' || migration_count::text || '|' || migration_head || '|' ||
       array_to_string(pending_versions, ',') || '|' || cardinality(security_failures)::text || '|' ||
       coalesce(array_to_string(security_failures, ','), '') || '|' || manifest_version
  as operational_readiness
from public.koaryu_release_schema_preflight_v17()
`;
export const V35_OPERATIONAL_READINESS_SQL = `
select ready::text || '|' || migration_count::text || '|' || migration_head || '|' ||
 array_to_string(pending_versions, ',') || '|' || cardinality(security_failures)::text || '|' ||
 coalesce(array_to_string(security_failures, ','), '') || '|' || manifest_version
 as operational_readiness from public.koaryu_release_schema_preflight_v16()
`;
export const V36_RECOVERY_MANIFEST_SQL = `
select private.koaryu_release_payer_setup_recovery_manifest_v36() as v36_recovery_manifest
`;
export const V34_OPERATIONAL_READINESS_SQL = `
select ready::text || '|' || migration_count::text || '|' || migration_head || '|' ||
 array_to_string(pending_versions, ',') || '|' || cardinality(security_failures)::text || '|' ||
 coalesce(array_to_string(security_failures, ','), '') || '|' || manifest_version
 as operational_readiness from public.koaryu_release_schema_preflight_v15()
`;
export const V35_EVIDENCE_MANIFEST_SQL = `
select private.koaryu_release_stripe_rehearsal_evidence_manifest_v35() as v35_evidence_manifest
`;

export const V30_OPERATIONAL_READINESS_SQL = `
select ready::text || '|' || migration_count::text || '|' || migration_head || '|' ||
       array_to_string(pending_versions, ',') || '|' || cardinality(security_failures)::text || '|' ||
       coalesce(array_to_string(security_failures, ','), '') || '|' || manifest_version
  as operational_readiness
from public.koaryu_release_schema_preflight_v11()
`;

export const V31_OPERATIONAL_READINESS_SQL = `
select ready::text || '|' || migration_count::text || '|' || migration_head || '|' ||
 array_to_string(pending_versions, ',') || '|' || cardinality(security_failures)::text || '|' ||
 coalesce(array_to_string(security_failures, ','), '') || '|' || manifest_version
 as operational_readiness from public.koaryu_release_schema_preflight_v12()
`;
export const V32_OPERATIONAL_READINESS_SQL = `
select ready::text || '|' || migration_count::text || '|' || migration_head || '|' ||
 array_to_string(pending_versions, ',') || '|' || cardinality(security_failures)::text || '|' ||
 coalesce(array_to_string(security_failures, ','), '') || '|' || manifest_version
 as operational_readiness from public.koaryu_release_schema_preflight_v13()
`;
export const V33_OPERATIONAL_READINESS_SQL = `
select ready::text || '|' || migration_count::text || '|' || migration_head || '|' ||
 array_to_string(pending_versions, ',') || '|' || cardinality(security_failures)::text || '|' ||
 coalesce(array_to_string(security_failures, ','), '') || '|' || manifest_version
 as operational_readiness from public.koaryu_release_schema_preflight_v14()
`;

export const V29_OPERATIONAL_READINESS_SQL = `
select ready::text || '|' || migration_count::text || '|' || migration_head || '|' ||
       array_to_string(pending_versions, ',') || '|' || cardinality(security_failures)::text || '|' ||
       coalesce(array_to_string(security_failures, ','), '') || '|' || manifest_version
  as operational_readiness
from public.koaryu_release_schema_preflight_v10()
`;

export const V28_OPERATIONAL_READINESS_SQL = `
select ready::text || '|' || migration_count::text || '|' || migration_head || '|' ||
       array_to_string(pending_versions, ',') || '|' || cardinality(security_failures)::text || '|' ||
       coalesce(array_to_string(security_failures, ','), '') || '|' || manifest_version
  as operational_readiness
from public.koaryu_release_schema_preflight_v9()
`;

export const V27_OPERATIONAL_READINESS_SQL = `
select ready::text || '|' || migration_count::text || '|' || migration_head || '|' ||
       array_to_string(pending_versions, ',') || '|' || cardinality(security_failures)::text || '|' ||
       coalesce(array_to_string(security_failures, ','), '') || '|' || manifest_version
  as operational_readiness
from public.koaryu_release_schema_preflight_v8()
`;

export const SCHEDULE_V25_OPERATIONAL_READINESS_SQL = `
select ready::text || '|' || migration_count::text || '|' || migration_head || '|' ||
       array_to_string(pending_versions, ',') || '|' || cardinality(security_failures)::text || '|' ||
       coalesce(array_to_string(security_failures, ','), '') || '|' || manifest_version
  as operational_readiness
from public.koaryu_release_schema_preflight_v5()
`;

export const V25_OPERATIONAL_READINESS_SQL = `
select ready::text || '|' || migration_count::text || '|' || migration_head || '|' ||
       array_to_string(pending_versions, ',') || '|' || cardinality(security_failures)::text || '|' ||
       coalesce(array_to_string(security_failures, ','), '') || '|' || manifest_version
  as operational_readiness
from public.koaryu_release_schema_preflight_v6()
`;

export const V26_OPERATIONAL_READINESS_SQL = `
select ready::text || '|' || migration_count::text || '|' || migration_head || '|' ||
       array_to_string(pending_versions, ',') || '|' || cardinality(security_failures)::text || '|' ||
       coalesce(array_to_string(security_failures, ','), '') || '|' || manifest_version
  as operational_readiness
from public.koaryu_release_schema_preflight_v7()
`;

export const CRITICAL_SURFACE_MANIFEST_SQL = `
select private.koaryu_release_critical_surface_manifest_v18()
  as critical_surface_manifest
`;

export const SCHEDULE_WINDOW_MANIFEST_SQL = `
select private.koaryu_release_schedule_window_manifest_v1()
  as schedule_window_manifest
`;

export const V26_EXPECTATION_STATE_SQL = `
select count(*)::text || ':' ||
       encode(
         extensions.digest(
           convert_to(
             coalesce(
               string_agg(
                 expectation_key || ':' || expected_sha256,
                 '|' order by expectation_key collate "C"
               ),
               ''
             ),
             'UTF8'
           ),
           'sha256'
         ),
         'hex'
       ) as v26_expectation_state
  from private.koaryu_release_v26_expectations
`;

export const V27_EXPECTATION_STATE_SQL = `
select count(*)::text || ':' ||
       encode(
         extensions.digest(
           convert_to(
             coalesce(string_agg(expectation_key || ':' || expected_sha256, '|' order by expectation_key collate "C"), ''),
             'UTF8'
           ),
           'sha256'
         ),
         'hex'
       ) as v27_expectation_state
  from private.koaryu_release_v27_expectations
`;

export const V28_EXPECTATION_STATE_SQL = `
select count(*)::text || ':' ||
       encode(
         extensions.digest(
           convert_to(
             coalesce(string_agg(expectation_key || ':' || expected_sha256, '|' order by expectation_key collate "C"), ''),
             'UTF8'
           ),
           'sha256'
         ),
         'hex'
       ) as v28_expectation_state
  from private.koaryu_release_v28_expectations
`;

export const V29_EXPECTATION_STATE_SQL = `
select count(*)::text || ':' ||
       encode(
         extensions.digest(
           convert_to(
             coalesce(string_agg(expectation_key || ':' || expected_sha256, '|' order by expectation_key collate "C"), ''),
             'UTF8'
           ),
           'sha256'
         ),
         'hex'
       ) as v29_expectation_state
  from private.koaryu_release_v29_expectations
`;

export const V29_TRANSITION_MANIFEST_SQL = `
select private.koaryu_release_enrollment_transition_manifest_v29()
  as v29_transition_manifest
`;

export const V29_OPERATIONAL_CONTRACT_SQL = `
select private.koaryu_release_operational_contract_v29()
  as v29_operational_contract
`;

export const V29_OPERATIONAL_MANIFEST_SQL = `
select private.koaryu_release_operational_manifest_v10()
  as v29_operational_manifest
`;

export const V30_EXPECTATION_STATE_SQL = `
select count(*)::text || ':' ||
       encode(
         extensions.digest(
           convert_to(
             coalesce(string_agg(expectation_key || ':' || expected_sha256, '|' order by expectation_key collate "C"), ''),
             'UTF8'
           ),
           'sha256'
         ),
         'hex'
       ) as v30_expectation_state
  from private.koaryu_release_v30_expectations
`;

export const V30_REPLAY_REPAIRS_MANIFEST_SQL = `
select private.koaryu_release_payments_replay_repairs_manifest_v30()
  as v30_replay_repairs_manifest
`;

export const V30_OPERATIONAL_CONTRACT_SQL = `
select private.koaryu_release_operational_contract_v30()
  as v30_operational_contract
`;

export const V30_OPERATIONAL_MANIFEST_SQL = `
select private.koaryu_release_operational_manifest_v11()
  as v30_operational_manifest
`;

export const V31_EXPECTATION_STATE_SQL = `
select count(*)::text || ':' ||
       encode(
         extensions.digest(
           convert_to(
             coalesce(string_agg(expectation_key || ':' || expected_sha256, '|' order by expectation_key collate "C"), ''),
             'UTF8'
           ),
           'sha256'
         ),
         'hex'
       ) as v31_expectation_state
  from private.koaryu_release_v31_expectations
`;

export const V31_RESOURCE_OWNERSHIP_MANIFEST_SQL = `
select private.koaryu_release_resource_ownership_manifest_v31()
  as v31_resource_ownership_manifest
`;

export const V31_OPERATIONAL_CONTRACT_SQL = `
select private.koaryu_release_operational_contract_v31()
  as v31_operational_contract
`;

export const V31_OPERATIONAL_MANIFEST_SQL = `
select private.koaryu_release_operational_manifest_v12()
  as v31_operational_manifest
`;

export const PREDECESSOR_OPERATIONAL_READINESS_SQL = `
select ready::text || '|' || migration_count::text || '|' || migration_head || '|' ||
       array_to_string(pending_versions, ',') || '|' || cardinality(security_failures)::text || '|' ||
       coalesce(array_to_string(security_failures, ','), '') || '|' || manifest_version
  as operational_readiness
from public.koaryu_release_schema_preflight_v2()
`;

export const EXPECTED_WRITER_RETURN_CONTRACT_STATE =
  "4:13fe0a7d1e4e2d1483fa5bb73e77b0097c62f85348b9897b5a256f21950c19b1:0";

export const WRITER_RETURN_CONTRACT_STATE_SQL = `
with required_functions(signature, expected_result) as (
  values
    ('public.write_student_profile_atomic(uuid, uuid, uuid, jsonb, uuid[], jsonb, boolean, text)', 'students'),
    ('private.write_student_profile_atomic(uuid, uuid, uuid, jsonb, uuid[], jsonb, boolean, text)', 'students'),
    ('public.import_student_row_atomic(jsonb, uuid, uuid, text, integer, text, text, text, text, uuid[])', 'TABLE(student_id uuid, guardian_imported boolean)'),
    ('private.import_student_row_atomic(jsonb, uuid, uuid, text, integer, text, text, text, text, uuid[])', 'TABLE(student_id uuid, guardian_imported boolean)')
),
actual as (
  select format('%I.%I(%s)', namespace.nspname, function.proname, oidvectortypes(function.proargtypes)) as signature,
         replace(pg_get_function_result(function.oid), 'public.', '') as result_contract
    from pg_proc function
    join pg_namespace namespace on namespace.oid = function.pronamespace
    join required_functions required
      on required.signature = format('%I.%I(%s)', namespace.nspname, function.proname, oidvectortypes(function.proargtypes))
),
compared as (
  select required.signature, required.expected_result, actual.result_contract
    from required_functions required
    left join actual using (signature)
)
select count(*)::text || ':' ||
       encode(extensions.digest(convert_to(string_agg(signature || ':' || coalesce(result_contract, ''), '|' order by signature collate "C"), 'UTF8'), 'sha256'), 'hex') || ':' ||
       count(*) filter (where result_contract is distinct from expected_result)::text
  as writer_return_contract_state
from compared
`;

export const TOLERATED_HISTORY_COLUMNS = Object.freeze([
  "created_by",
  "idempotency_key",
  "rollback",
]);

const REQUIRED_HISTORY_COLUMNS = Object.freeze(["version", "statements", "name"]);
const HISTORY_COLUMN_KEYS = Object.freeze([
  "column_default",
  "column_name",
  "data_type",
  "is_generated",
  "is_identity",
  "is_nullable",
  "udt_name",
]);

const HISTORY_COLUMN_DEFINITIONS = Object.freeze({
  version: Object.freeze({
    column_name: "version",
    data_type: "text",
    udt_name: "text",
    is_nullable: "NO",
    column_default: null,
    is_generated: "NEVER",
    is_identity: "NO",
  }),
  statements: Object.freeze({
    column_name: "statements",
    data_type: "ARRAY",
    udt_name: "_text",
    is_nullable: "YES",
    column_default: null,
    is_generated: "NEVER",
    is_identity: "NO",
  }),
  name: Object.freeze({
    column_name: "name",
    data_type: "text",
    udt_name: "text",
    is_nullable: "YES",
    column_default: null,
    is_generated: "NEVER",
    is_identity: "NO",
  }),
  created_by: Object.freeze({
    column_name: "created_by",
    data_type: "text",
    udt_name: "text",
    is_nullable: "YES",
    column_default: null,
    is_generated: "NEVER",
    is_identity: "NO",
  }),
  idempotency_key: Object.freeze({
    column_name: "idempotency_key",
    data_type: "text",
    udt_name: "text",
    is_nullable: "YES",
    column_default: null,
    is_generated: "NEVER",
    is_identity: "NO",
  }),
  rollback: Object.freeze({
    column_name: "rollback",
    data_type: "ARRAY",
    udt_name: "_text",
    is_nullable: "YES",
    column_default: null,
    is_generated: "NEVER",
    is_identity: "NO",
  }),
});

function historySchemaRejection(reason) {
  return { accepted: false, reason };
}

export function validateHistoryColumnMetadata(columns) {
  if (!Array.isArray(columns)) {
    return historySchemaRejection("History-column metadata must be an array");
  }

  const columnsByName = new Map();
  for (const [index, column] of columns.entries()) {
    if (
      column === null ||
      typeof column !== "object" ||
      Array.isArray(column) ||
      typeof column.column_name !== "string" ||
      JSON.stringify(Object.keys(column).sort()) !== JSON.stringify(HISTORY_COLUMN_KEYS)
    ) {
      return historySchemaRejection(
        `History-column metadata at index ${index} must have the exact seven-field shape`,
      );
    }
    if (/(?:hash|checksum|digest)/i.test(column.column_name)) {
      return historySchemaRejection(
        `History column ${column.column_name} is a prohibited hash/checksum/digest column`,
      );
    }
    if (!Object.hasOwn(HISTORY_COLUMN_DEFINITIONS, column.column_name)) {
      return historySchemaRejection(`Unrecognised history column ${column.column_name}`);
    }
    if (columnsByName.has(column.column_name)) {
      return historySchemaRejection(`Duplicate history column ${column.column_name}`);
    }
    columnsByName.set(column.column_name, column);
  }

  for (const name of REQUIRED_HISTORY_COLUMNS) {
    if (!columnsByName.has(name)) {
      return historySchemaRejection(`Missing required history column ${name}`);
    }
  }

  for (const [name, column] of columnsByName) {
    const expected = HISTORY_COLUMN_DEFINITIONS[name];
    const mismatches = [];
    if (column.data_type !== expected.data_type || column.udt_name !== expected.udt_name) {
      mismatches.push(
        `type/UDT expected ${expected.data_type}/${expected.udt_name} but received ` +
          `${String(column.data_type)}/${String(column.udt_name)}`,
      );
    }
    if (column.is_nullable !== expected.is_nullable) {
      mismatches.push(
        `nullability expected ${expected.is_nullable} but received ${String(column.is_nullable)}`,
      );
    }
    if (column.column_default !== expected.column_default) {
      mismatches.push(
        `default expected null but received ${JSON.stringify(column.column_default)}`,
      );
    }
    if (column.is_generated !== expected.is_generated) {
      mismatches.push(
        `generated status expected ${expected.is_generated} but received ` +
          `${String(column.is_generated)}`,
      );
    }
    if (column.is_identity !== expected.is_identity) {
      mismatches.push(
        `identity status expected ${expected.is_identity} but received ` +
          `${String(column.is_identity)}`,
      );
    }
    if (mismatches.length > 0) {
      return historySchemaRejection(
        `History column ${name} definition mismatch: ${mismatches.join("; ")}`,
      );
    }
  }

  // CLI 2.95.4 inserts only (version, name, statements). Any optional column is
  // therefore pinned to staging's reviewed nullable definition so an omitted
  // value remains valid; the null default also refuses unreviewed schema drift.
  return { accepted: true };
}

const HISTORY_COLUMNS_SQL = `
select coalesce(
         json_agg(
           json_build_object(
             'column_name', column_name,
             'data_type', data_type,
             'udt_name', udt_name,
             'is_nullable', is_nullable,
             'column_default', column_default,
             'is_generated', is_generated,
             'is_identity', is_identity
           )
           order by ordinal_position
         )::text,
         '[]'
       ) as history_columns
from information_schema.columns
where table_schema = 'supabase_migrations'
  and table_name = 'schema_migrations'
`;

const MIGRATION_ROW_COUNT_SQL = `
select count(*)::text as migration_row_count
from supabase_migrations.schema_migrations
`;

const MIGRATION_NEWEST_VERSION_SQL = `
select coalesce(max(to_jsonb(schema_migration)->>'version'), '')
  as migration_newest_version
from supabase_migrations.schema_migrations as schema_migration
`;

const HISTORY_SQL = `
select count(*)::text || ':' ||
       md5(string_agg(version || ':' || name, '|' order by version))
  as history_state
from supabase_migrations.schema_migrations
`;

const TARGET_HISTORY_SQL = `
select coalesce(
         string_agg(version || ':' || name, '|' order by version),
         ''
       ) as target_history
from supabase_migrations.schema_migrations
where version >= '20260727100000'
`;

const OBJECT_COUNTS_SQL = `
select
  (select count(*)
     from pg_proc p
     join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in (
        'preserve_studio_comp_provenance',
        'set_studio_comp_atomic',
        'clear_studio_comp_for_billing_event'
      ))::text
  || ':' ||
  (select count(*)
     from pg_trigger t
     join pg_class c on c.oid = t.tgrelid
     join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relname = 'studio_subscriptions'
      and t.tgname = 'preserve_studio_comp_provenance_on_metadata_update'
      and not t.tgisinternal)::text
  as object_counts
`;

export const FUNCTION_STATE_SQL = `
with expected(signature, expected_config, service_execute) as (
  values
    (
      'public.preserve_studio_comp_provenance()',
      array['search_path=pg_catalog']::text[],
      false
    ),
    (
      'public.set_studio_comp_atomic(uuid, boolean, text, uuid, text, boolean)',
      array['search_path=public, pg_temp']::text[],
      true
    ),
    (
      'public.clear_studio_comp_for_billing_event(uuid, bigint)',
      array['search_path=public, pg_temp']::text[],
      true
    )
),
actual as (
  select
    format('%I.%I(%s)', n.nspname, p.proname, oidvectortypes(p.proargtypes)) as signature,
    md5(pg_get_functiondef(p.oid)) as definition_md5,
    owner.rolname as owner_name,
    p.prosecdef,
    p.proconfig,
    exists (
      select 1
        from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) acl
       where acl.grantee = 0
         and acl.privilege_type = 'EXECUTE'
    ) as public_execute,
    has_function_privilege('anon', p.oid, 'EXECUTE') as anon_execute,
    has_function_privilege('authenticated', p.oid, 'EXECUTE') as authenticated_execute,
    exists (
      select 1
        from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) acl
        join pg_roles granted on granted.oid = acl.grantee
       where granted.rolname = 'service_role'
         and acl.privilege_type = 'EXECUTE'
         and not acl.is_grantable
    ) as service_execute,
    exists (
      select 1
        from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) acl
        left join pg_roles granted on granted.oid = acl.grantee
       where acl.privilege_type = 'EXECUTE'
         and acl.grantee <> p.proowner
         and not (
           granted.rolname = 'service_role'
           and p.proname in (
             'set_studio_comp_atomic',
             'clear_studio_comp_for_billing_event'
           )
           and not acl.is_grantable
         )
    ) as unexpected_execute_grant
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  join pg_roles owner on owner.oid = p.proowner
  where n.nspname = 'public'
    and p.proname in (
      'preserve_studio_comp_provenance',
      'set_studio_comp_atomic',
      'clear_studio_comp_for_billing_event'
    )
),
compared as (
  select
    e.signature,
    a.definition_md5,
    a.owner_name,
    a.prosecdef,
    a.proconfig,
    a.public_execute,
    a.anon_execute,
    a.authenticated_execute,
    a.service_execute,
    a.unexpected_execute_grant,
    e.expected_config,
    e.service_execute as expected_service_execute
  from expected e
  full join actual a using (signature)
)
select
  count(definition_md5)::text || ':' ||
  coalesce(
    md5(string_agg(
      signature || ':' || definition_md5 || ':' || owner_name || ':' ||
      prosecdef::text || ':' || array_to_string(proconfig, ',') || ':' ||
      public_execute::text || ':' || anon_execute::text || ':' ||
      authenticated_execute::text || ':' || service_execute::text,
      '|' order by signature
    )),
    md5('')
  ) || ':' ||
  count(*) filter (
    where definition_md5 is null
       or owner_name <> 'postgres'
       or prosecdef
       or proconfig is distinct from expected_config
       or public_execute
       or anon_execute
       or authenticated_execute
       or service_execute is distinct from expected_service_execute
       or unexpected_execute_grant
  )::text as function_state
from compared
`;

export const TRIGGER_STATE_SQL = `
with actual as (
  select
    t.oid,
    md5(pg_get_triggerdef(t.oid)) as definition_md5,
    t.tgenabled,
    t.tgtype,
    t.tgattr::text as trigger_attributes,
    metadata.attnum::text as metadata_attribute,
    table_owner.rolname as table_owner,
    fn_namespace.nspname as function_schema,
    fn.proname as function_name,
    oidvectortypes(fn.proargtypes) as function_arguments
  from pg_trigger t
  join pg_class c on c.oid = t.tgrelid
  join pg_namespace n on n.oid = c.relnamespace
  join pg_roles table_owner on table_owner.oid = c.relowner
  join pg_proc fn on fn.oid = t.tgfoid
  join pg_namespace fn_namespace on fn_namespace.oid = fn.pronamespace
  join pg_attribute metadata
    on metadata.attrelid = c.oid
   and metadata.attname = 'metadata'
   and not metadata.attisdropped
  where n.nspname = 'public'
    and c.relname = 'studio_subscriptions'
    and t.tgname = 'preserve_studio_comp_provenance_on_metadata_update'
    and not t.tgisinternal
)
select
  count(*)::text || ':' ||
  coalesce(
    md5(string_agg(definition_md5 || ':' || table_owner, '|' order by definition_md5)),
    md5('')
  ) || ':' ||
  count(*) filter (
    where tgenabled <> 'O'
       or tgtype <> 19
       or trigger_attributes <> metadata_attribute
       or table_owner <> 'postgres'
       or function_schema <> 'public'
       or function_name <> 'preserve_studio_comp_provenance'
       or function_arguments <> ''
  )::text as trigger_state
from actual
`;

export const CATALOG_STATE_SQL = `
with runtime_settings as materialized (
  select set_config('TimeZone', 'UTC', true)
),
required_tables(schema_name, table_name, rls_enabled, service_privileges) as (
  select * from (values
    ('public', 'studio_live_billing_authorizations', true, 'SELECT'),
    ('public', 'stripe_live_billing_reconciliation_checkpoints', true, 'SELECT'),
    ('public', 'stripe_connect_account_dispositions', true, 'SELECT'),
    ('public', 'stripe_live_billing_reconciliation_account_evidence', true, 'SELECT'),
    ('public', 'stripe_connect_onboarding_bootstraps', true, ''),
    ('public', 'operational_alert_episodes', true, 'INSERT,SELECT,UPDATE'),
    ('public', 'operational_alert_outbox', true, 'INSERT,SELECT,UPDATE'),
    ('public', 'operational_alert_delivery_attempts', true, 'INSERT,SELECT'),
    ('public', 'operational_alert_delivery_outcomes', true, 'INSERT,SELECT'),
    ('public', 'operational_alert_audit_events', true, 'INSERT,SELECT'),
    ('public', 'operational_alert_heartbeats', true, 'INSERT,SELECT,UPDATE'),
    ('private', 'stripe_connect_account_identity_guards', false, ''),
    ('private', 'koaryu_release_v26_expectations', true, '')
  ) as base(schema_name, table_name, rls_enabled, service_privileges)
  union all
  select * from (values
    ('private', 'koaryu_release_v27_expectations', true, ''),
    ('private', 'koaryu_release_v28_expectations', true, ''),
    ('private', 'koaryu_release_v29_expectations', true, ''),
    ('private', 'koaryu_release_v30_expectations', true, ''),
    ('private', 'koaryu_release_v31_expectations', true, '')
  ) as final_expectations(schema_name, table_name, rls_enabled, service_privileges)
   where to_regprocedure('public.koaryu_release_schema_preflight_v12()') is not null
  union all
  select * from (values
    ('private','billing_invoice_retry_hash_capture_control_v33',true,''),
    ('private','billing_invoice_retry_hash_ledger_v33',true,'')
  ) as v33_tables(schema_name,table_name,rls_enabled,service_privileges)
   where to_regprocedure('public.koaryu_release_schema_preflight_v15()') is not null
  union all
  select * from (values
    ('private','koaryu_release_v35_expectations',true,'')
  ) as v35_tables(schema_name,table_name,rls_enabled,service_privileges)
   where to_regprocedure('public.koaryu_release_schema_preflight_v16()') is not null
  union all
  select * from (values
    ('private','koaryu_release_v36_expectations',true,'')
  ) as v36_tables(schema_name,table_name,rls_enabled,service_privileges)
   where to_regprocedure('public.koaryu_release_schema_preflight_v17()') is not null
),
acl_scope_tables(schema_name, table_name) as (
  select schema_name, table_name from required_tables
  union all
  values
    ('public', 'studio_payment_accounts'),
    ('public', 'stripe_events')
  union all
  select 'public', 'billing_invoice_mutation_owners'
   where to_regprocedure('public.koaryu_release_schema_preflight_v12()') is not null
),
scoped_definition_tables(schema_name, table_name) as (
  select schema_name, table_name from required_tables
  union all
  select 'public', 'studio_payment_accounts'
  union all
  select 'public', 'billing_invoice_mutation_owners'
   where to_regprocedure('public.koaryu_release_schema_preflight_v12()') is not null
),
table_actual as (
  select
    namespace.nspname as schema_name,
    relation.relname as table_name,
    owner.rolname as owner_name,
    relation.relrowsecurity,
    coalesce((
      select string_agg(
               coalesce(grantor.rolname, 'PUBLIC') || '>' ||
               coalesce(grantee.rolname, 'PUBLIC') || ':' || acl.privilege_type || ':' || acl.is_grantable::text,
               ',' order by coalesce(grantor.rolname, 'PUBLIC') collate "C", coalesce(grantee.rolname, 'PUBLIC') collate "C", acl.privilege_type collate "C", acl.is_grantable
             )
        from aclexplode(coalesce(relation.relacl, acldefault('r', relation.relowner))) acl
        left join pg_roles grantor on grantor.oid = acl.grantor
        left join pg_roles grantee on grantee.oid = acl.grantee
    ), '') as acl_state,
    exists (
      select 1
        from aclexplode(coalesce(relation.relacl, acldefault('r', relation.relowner))) acl
       where acl.grantee = 0
    ) as public_access,
    has_table_privilege('anon', relation.oid, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') as anon_access,
    has_table_privilege('authenticated', relation.oid, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') as authenticated_access,
    concat_ws(',',
      case when has_table_privilege('service_role', relation.oid, 'INSERT') then 'INSERT' end,
      case when has_table_privilege('service_role', relation.oid, 'SELECT') then 'SELECT' end,
      case when has_table_privilege('service_role', relation.oid, 'UPDATE') then 'UPDATE' end,
      case when has_table_privilege('service_role', relation.oid, 'DELETE') then 'DELETE' end,
      case when has_table_privilege('service_role', relation.oid, 'TRUNCATE') then 'TRUNCATE' end,
      case when has_table_privilege('service_role', relation.oid, 'REFERENCES') then 'REFERENCES' end,
      case when has_table_privilege('service_role', relation.oid, 'TRIGGER') then 'TRIGGER' end
    ) as service_privileges
  from pg_class relation
  join pg_namespace namespace on namespace.oid = relation.relnamespace
  join pg_roles owner on owner.oid = relation.relowner
  join required_tables required
    on required.schema_name = namespace.nspname and required.table_name = relation.relname
  where relation.relkind = 'r'
),
table_compared as (
  select required.*, actual.owner_name, actual.relrowsecurity,
         actual.public_access, actual.anon_access, actual.authenticated_access,
         actual.service_privileges as actual_service_privileges,
         actual.acl_state
    from required_tables required
    left join table_actual actual using (schema_name, table_name)
),
table_acl_definitions as (
  select namespace.nspname as schema_name, relation.relname as table_name,
         owner.rolname as owner_name,
         coalesce((
           select string_agg(
                    coalesce(grantor.rolname, 'PUBLIC') || '>' ||
                    coalesce(grantee.rolname, 'PUBLIC') || ':' || acl.privilege_type || ':' || acl.is_grantable::text,
                    ',' order by coalesce(grantor.rolname, 'PUBLIC') collate "C", coalesce(grantee.rolname, 'PUBLIC') collate "C", acl.privilege_type collate "C", acl.is_grantable
                  )
             from aclexplode(coalesce(relation.relacl, acldefault('r', relation.relowner))) acl
             left join pg_roles grantor on grantor.oid = acl.grantor
             left join pg_roles grantee on grantee.oid = acl.grantee
         ), '') as acl_state
    from pg_class relation
    join pg_namespace namespace on namespace.oid = relation.relnamespace
    join pg_roles owner on owner.oid = relation.relowner
    join acl_scope_tables covered
      on covered.schema_name = namespace.nspname and covered.table_name = relation.relname
   where relation.relkind = 'r'
),
column_acl_definitions as (
  select namespace.nspname as schema_name,
         relation.relname as table_name,
         attribute.attnum,
         attribute.attname as column_name,
         coalesce((
           select string_agg(
                    coalesce(grantor.rolname, 'PUBLIC') || '>' ||
                    coalesce(grantee.rolname, 'PUBLIC') || ':' ||
                    acl.privilege_type || ':' || acl.is_grantable::text,
                    ',' order by coalesce(grantor.rolname, 'PUBLIC') collate "C",
                                 coalesce(grantee.rolname, 'PUBLIC') collate "C",
                                 acl.privilege_type collate "C", acl.is_grantable
                  )
             from aclexplode(attribute.attacl) acl
             left join pg_roles grantor on grantor.oid = acl.grantor
             left join pg_roles grantee on grantee.oid = acl.grantee
         ), '') as acl_state
    from pg_class relation
    join pg_namespace namespace on namespace.oid = relation.relnamespace
    join acl_scope_tables covered
      on covered.schema_name = namespace.nspname and covered.table_name = relation.relname
    join pg_attribute attribute
      on attribute.attrelid = relation.oid
     and attribute.attnum > 0
     and not attribute.attisdropped
   where relation.relkind = 'r'
),
required_policies(table_name, policy_name, permissive, command_name, role_names, predicate_kind) as (
  values
    ('studio_live_billing_authorizations', 'studio_live_billing_authorizations_no_client_access', false, '*', 'anon,authenticated', 'deny_all'),
    ('studio_live_billing_authorizations', 'reject_ambiguous_staff_membership_access', false, '*', 'authenticated', 'membership_guard'),
    ('stripe_live_billing_reconciliation_checkpoints', 'stripe_live_billing_reconciliation_checkpoints_no_client_access', false, '*', 'anon,authenticated', 'deny_all'),
    ('stripe_live_billing_reconciliation_checkpoints', 'reject_ambiguous_staff_membership_access', false, '*', 'authenticated', 'membership_guard'),
    ('stripe_connect_account_dispositions', 'stripe_connect_account_dispositions_no_client_access', false, '*', 'anon,authenticated', 'deny_all'),
    ('stripe_connect_account_dispositions', 'reject_ambiguous_staff_membership_access', false, '*', 'authenticated', 'membership_guard'),
    ('stripe_live_billing_reconciliation_account_evidence', 'stripe_live_billing_account_evidence_no_client_access', false, '*', 'anon,authenticated', 'deny_all'),
    ('stripe_live_billing_reconciliation_account_evidence', 'reject_ambiguous_staff_membership_access', false, '*', 'authenticated', 'membership_guard'),
    ('stripe_connect_onboarding_bootstraps', 'stripe_connect_onboarding_bootstraps_no_client_access', false, '*', 'anon,authenticated', 'deny_all'),
    ('stripe_connect_onboarding_bootstraps', 'reject_ambiguous_staff_membership_access', false, '*', 'authenticated', 'membership_guard'),
    ('operational_alert_episodes', 'reject_ambiguous_staff_membership_access', false, '*', 'authenticated', 'membership_guard'),
    ('operational_alert_outbox', 'reject_ambiguous_staff_membership_access', false, '*', 'authenticated', 'membership_guard'),
    ('operational_alert_delivery_attempts', 'reject_ambiguous_staff_membership_access', false, '*', 'authenticated', 'membership_guard'),
    ('operational_alert_delivery_outcomes', 'reject_ambiguous_staff_membership_access', false, '*', 'authenticated', 'membership_guard'),
    ('operational_alert_audit_events', 'reject_ambiguous_staff_membership_access', false, '*', 'authenticated', 'membership_guard'),
    ('operational_alert_heartbeats', 'reject_ambiguous_staff_membership_access', false, '*', 'authenticated', 'membership_guard')
),
policy_actual as (
  select relation.relname as table_name, policy.polname as policy_name,
         policy.polpermissive as permissive, policy.polcmd::text as command_name,
         (select string_agg(role.rolname, ',' order by role.rolname collate "C")
            from unnest(policy.polroles) role_oid
            join pg_roles role on role.oid = role_oid) as role_names,
         case
           when regexp_replace(pg_get_expr(policy.polqual, policy.polrelid), '[[:space:]()]', '', 'g') = 'false'
            and regexp_replace(pg_get_expr(policy.polwithcheck, policy.polrelid), '[[:space:]()]', '', 'g') = 'false'
             then 'deny_all'
           when regexp_replace(
                  regexp_replace(pg_get_expr(policy.polqual, policy.polrelid), '[[:space:]()]', '', 'g'),
                  'AShas_unambiguous_studio_membership$', ''
                ) = 'SELECTprivate.has_unambiguous_studio_membership'
            and regexp_replace(
                  regexp_replace(pg_get_expr(policy.polwithcheck, policy.polrelid), '[[:space:]()]', '', 'g'),
                  'AShas_unambiguous_studio_membership$', ''
                ) = 'SELECTprivate.has_unambiguous_studio_membership'
             then 'membership_guard'
           else 'unexpected'
         end as predicate_kind
    from pg_policy policy
    join pg_class relation on relation.oid = policy.polrelid
    join pg_namespace namespace on namespace.oid = relation.relnamespace
    join required_tables covered
      on covered.schema_name = 'public' and covered.table_name = relation.relname
   where namespace.nspname = 'public'
),
policy_compared as (
  select coalesce(required.table_name, actual.table_name) as table_name,
         coalesce(required.policy_name, actual.policy_name) as policy_name,
         required.permissive, required.command_name, required.role_names,
         required.predicate_kind,
         actual.permissive as actual_permissive,
         actual.command_name as actual_command_name,
         actual.role_names as actual_role_names,
         actual.predicate_kind as actual_predicate_kind,
         required.table_name is not null as expected_policy,
         actual.table_name is not null as actual_policy
    from required_policies required
    full join policy_actual actual using (table_name, policy_name)
),
base_required_functions(signature, search_path_config, security_definer, service_execute) as (
  values
    ('public.preserve_studio_comp_provenance()', 'search_path=pg_catalog', false, false),
    ('public.set_studio_comp_atomic(uuid, boolean, text, uuid, text, boolean)', 'search_path=public, pg_temp', false, true),
    ('public.clear_studio_comp_for_billing_event(uuid, bigint)', 'search_path=public, pg_temp', false, true),
    ('public.record_stripe_live_billing_reconciliation_checkpoint(text, integer, integer, integer, integer, integer, integer, timestamp with time zone, timestamp with time zone, integer, integer, boolean, boolean, timestamp with time zone, text, text, uuid, text)', 'search_path=public, pg_temp', true, false),
    ('public.record_stripe_live_billing_reconciliation_checkpoint_v2(jsonb, timestamp with time zone, text, text, uuid, text)', 'search_path=""', true, false),
    ('public.authorize_studio_live_billing_mutation_atomic(uuid, text, text, text, text)', 'search_path=""', true, true),
    ('public.authorize_connect_onboarding_bootstrap_account_create(uuid, text, integer, text, text, text, text, text)', 'search_path=""', true, false),
    ('public.bind_connect_onboarding_bootstrap_account(uuid, text, integer, text, text, text)', 'search_path=""', true, false),
    ('public.authorize_connect_onboarding_bootstrap_initial_link(uuid, text, integer, text, text, text, text, text)', 'search_path=""', true, false),
    ('private.connect_onboarding_bootstrap_link_checkpoint(uuid, text)', 'search_path=""', true, false),
    ('public.preflight_connect_onboarding_bootstrap_begin(uuid, text)', 'search_path=""', true, true),
    ('public.preflight_connect_onboarding_bootstrap_resume(uuid, text)', 'search_path=""', true, true),
    ('public.prepare_connect_onboarding_bootstrap_atomic(uuid, text, integer, jsonb, text, text, text, text)', 'search_path=""', true, true),
    ('public.load_connect_onboarding_bootstrap_recovery_context(uuid, text)', 'search_path=""', true, true),
    ('public.authorize_connect_onboarding_bootstrap_account_create_v2(uuid, uuid, text, integer, text, text)', 'search_path=""', true, true),
    ('public.bind_connect_onboarding_bootstrap_account_v2(uuid, uuid, text, integer, text, text)', 'search_path=""', true, true),
    ('public.authorize_connect_onboarding_bootstrap_initial_link_v2(uuid, uuid, text, integer, text, text, text, text)', 'search_path=""', true, true),
    ('public.record_connect_onboarding_bootstrap_initial_link_response(uuid, uuid, text, integer, text, text, text, text, text, text)', 'search_path=""', true, true),
    ('public.acknowledge_connect_onboarding_bootstrap_initial_link_delivery(uuid, text, text)', 'search_path=""', true, true),
    ('private.live_billing_event_is_in_scope(text, text)', 'search_path=""', true, false),
    ('private.enforce_live_billing_checkpoint_processed_events()', 'search_path=""', true, false),
    ('private.current_connect_account_generation(jsonb)', 'search_path=""', false, true),
    ('private.bind_live_billing_authorization_checkpoint()', 'search_path=""', true, false),
    ('public.set_stripe_connect_account_exclusion_atomic(text, boolean, text, uuid, text)', 'search_path=public, pg_temp', true, true),
    ('public.finish_stripe_event_processing_v2(uuid, text, text, text, text)', 'search_path=public, pg_temp', false, true),
    ('public.prevent_operational_alert_append_only_mutation()', 'search_path=""', false, false),
    ('public.enforce_operational_alert_sent_receipt()', 'search_path=""', false, false),
    ('public.operational_alert_metric_counts()', 'search_path=public, pg_temp', false, true),
    ('public.evaluate_operational_alert(text, text, bigint, integer, integer, text, text, text, text)', 'search_path=public, pg_temp', false, false),
    ('public.evaluate_operational_alert(text, text, bigint, integer, integer, text, text, integer, text, text, text)', 'search_path=public, pg_temp', false, true),
    ('public.acknowledge_operational_alert(text, uuid, text, text)', 'search_path=public, pg_temp', false, true),
    ('public.claim_operational_alert_delivery(text, text, uuid, integer)', 'search_path=public, pg_temp', false, true),
    ('public.complete_operational_alert_delivery(uuid, text, text)', 'search_path=public, pg_temp', false, true),
    ('public.fail_operational_alert_delivery(uuid, text, text, integer)', 'search_path=public, pg_temp', false, true),
    ('public.record_operational_alert_heartbeat(text, text, text)', 'search_path=public, pg_temp', false, true),
    ('public.operational_alert_heartbeats(text)', 'search_path=public, pg_temp', false, true),
    ('public.koaryu_release_schema_preflight()', 'search_path=pg_catalog', true, true),
    ('public.koaryu_release_schema_preflight_v2()', 'search_path=pg_catalog', true, true),
    ('public.koaryu_release_schema_preflight_v3()', 'search_path=pg_catalog', true, true),
    ('public.koaryu_release_schema_preflight_v4()', 'search_path=pg_catalog', true, true),
    ('public.koaryu_release_schema_preflight_v5()', 'search_path=pg_catalog', true, true),
    ('public.koaryu_release_schema_preflight_v6()', 'search_path=pg_catalog', true, true),
    ('private.koaryu_release_operational_manifest_v2()', 'search_path=pg_catalog', false, false),
    ('private.koaryu_release_operational_manifest_v2_base()', 'search_path=pg_catalog', false, false),
    ('private.koaryu_release_operational_manifest_v4()', 'search_path=pg_catalog', false, false),
    ('private.koaryu_release_operational_manifest_v5()', 'search_path=pg_catalog', false, false),
    ('private.koaryu_release_operational_manifest_v6()', 'search_path=pg_catalog', false, false),
    ('private.koaryu_release_operational_manifest_v7()', 'search_path=pg_catalog,TimeZone=UTC', false, false),
    ('private.koaryu_release_starting_belt_manifest_v9()', 'search_path=pg_catalog', false, false),
    ('private.koaryu_release_student_rank_writer_manifest_v11()', 'search_path=pg_catalog', false, false),
    ('private.koaryu_release_student_rank_writer_manifest_v13()', 'search_path=pg_catalog', false, false),
    ('private.koaryu_release_critical_surface_manifest_v15()', 'search_path=pg_catalog', false, false),
    ('private.koaryu_release_critical_surface_manifest_v16()', 'search_path=pg_catalog', false, false),
    ('private.koaryu_release_schedule_window_manifest_v1()', 'search_path=pg_catalog', false, false),
    ('public.schedule_window_read(uuid, date, date, text)', 'search_path=pg_catalog', false, true),
    ('public.write_student_profile_atomic(uuid, uuid, uuid, jsonb, uuid[], jsonb, boolean, text)', 'search_path=pg_catalog, public, private', false, true),
    ('public.write_student_profile_v2_atomic(uuid, uuid, uuid, jsonb, uuid[], jsonb, boolean, text)', 'search_path=pg_catalog, public', false, true),
    ('public.reserve_core_checkout_v2_atomic(uuid)', 'search_path=pg_catalog, public', false, true),
    ('public.set_studio_comp_v2_atomic(uuid, boolean, text, uuid, text, boolean)', 'search_path=pg_catalog, public', false, true),
    ('public.sync_belt_ladder_ranks_v2(uuid, uuid, uuid, uuid, text, jsonb)', 'search_path=pg_catalog, public', false, true),
    ('public.record_core_checkout_compensation_required_atomic(uuid, text, text, bigint, text, boolean)', 'search_path=pg_catalog, public', false, true),
    ('private.record_student_rank_transition_v2(uuid, uuid, uuid, uuid, uuid, uuid, uuid, text, text, uuid)', 'search_path=public, pg_temp', false, true),
    ('public.record_student_promotion(uuid, uuid, uuid, uuid, uuid, uuid, uuid, text)', 'search_path=pg_catalog', false, true),
    ('public.record_student_demotion(uuid, uuid, uuid, uuid, uuid, uuid, uuid, text)', 'search_path=pg_catalog', false, true),
    ('public.record_student_promotion_v2(uuid, uuid, uuid, uuid, uuid, uuid, uuid, text, uuid)', 'search_path=pg_catalog', false, true),
    ('public.record_student_demotion_v2(uuid, uuid, uuid, uuid, uuid, uuid, uuid, text, uuid)', 'search_path=pg_catalog', false, true),
    ('private.write_student_profile_atomic(uuid, uuid, uuid, jsonb, uuid[], jsonb, boolean, text)', 'search_path=public, pg_temp', false, true),
    ('public.import_student_row_atomic(jsonb, uuid, uuid, text, integer, text, text, text, text, uuid[])', 'search_path=pg_catalog, public, private', false, true),
    ('private.import_student_row_atomic(jsonb, uuid, uuid, text, integer, text, text, text, text, uuid[])', 'search_path=public, pg_temp', false, true),
    ('private.sync_connect_identity_mapping_guard()', 'search_path=pg_catalog', true, false),
    ('private.sync_connect_identity_exclusion_guard()', 'search_path=pg_catalog', true, false),
    ('public.record_stripe_live_billing_reconciliation_checkpoint_v3(jsonb, timestamp with time zone, text, text, uuid, text)', 'search_path=""', true, true),
    ('private.koaryu_release_operational_contract_v25()', 'search_path=pg_catalog,TimeZone=UTC', false, false),
    ('private.koaryu_release_live_billing_v3_manifest_v25()', 'search_path=pg_catalog', false, false),
    ('private.recompute_billing_payment_adjustment_totals(uuid)', 'search_path=""', false, true),
    ('private.validate_billing_adjustment_payment_identity()', 'search_path=""', false, false),
    ('private.recompute_payment_after_adjustment_change()', 'search_path=""', false, false),
    ('private.koaryu_release_payment_adjustment_manifest_v26()', 'search_path=pg_catalog', false, false),
    ('private.koaryu_release_operational_contract_v26()', 'search_path=pg_catalog,TimeZone=UTC', false, false)
),
required_functions(signature, search_path_config, security_definer, service_execute) as (
  select * from base_required_functions
  union all
  select 'public.set_studio_live_billing_authorization_atomic(uuid, text, boolean, timestamp with time zone, text, uuid, text, text)',
         'search_path=public, pg_temp', true, true
  union all
  select 'public.set_studio_live_billing_authorization_operations_v1(uuid, text, boolean, timestamp with time zone, text, uuid, text[], text, text)',
         'search_path=""', true, true
   where to_regprocedure('public.koaryu_release_schema_preflight_v11()') is not null
  union all
  select * from (values
    ('private.billing_operation_resource_version_v31(text, billing_payments, billing_payers, text, integer)', 'search_path=pg_catalog', false, false),
    ('private.billing_plan_resource_version_v31(billing_plans, text, integer)', 'search_path=pg_catalog', false, false),
    ('private.claim_billing_invoice_mutation_v31(uuid, uuid, text, text, uuid, uuid, text, text, text, integer, uuid, integer)', 'search_path=""', true, false),
    ('private.claim_payment_payer_operation_resource_v31(uuid, uuid, text, text, uuid, uuid, text, text, text, integer, uuid, integer)', 'search_path=""', true, false),
    ('private.maintain_billing_invoice_mutation_owner_v31()', 'search_path=""', false, false),
    ('private.preserve_billing_invoice_mutation_owner_v31()', 'search_path=""', false, false),
    ('public.claim_billing_invoice_closeout_operation_v1(uuid, uuid, text, text, uuid, uuid, text, text, text, integer, uuid, integer)', 'search_path=""', true, true),
    ('public.claim_billing_invoice_closeout_operation_v30(uuid, uuid, text, text, uuid, uuid, text, text, text, integer, uuid, integer)', 'search_path=""', true, false),
    ('public.claim_billing_provider_operation_resource_v1(uuid, uuid, text, text, uuid, uuid, text, text, text, integer, uuid, integer)', 'search_path=""', true, true),
    ('public.claim_billing_provider_operation_resource_v30(uuid, uuid, text, text, uuid, uuid, text, text, text, integer, uuid, integer)', 'search_path=""', true, false),
    ('public.claim_due_billing_enrollment_transitions_v1(uuid, integer, integer)', 'search_path=""', true, true),
    ('public.disable_billing_payer_autopay_v1(uuid, uuid, uuid, timestamp with time zone, text)', 'search_path=""', true, true),
    ('public.finalize_billing_payer_setup_projection_v1(uuid, uuid, uuid, uuid, uuid, text, text, text, integer)', 'search_path=""', true, true),
    ('public.authorize_billing_provider_operation_recovery_v2(uuid, uuid, uuid, text, text, text, text, integer, uuid, text, text, text, uuid, integer, bigint)', 'search_path=""', true, true),
    ('public.mark_billing_provider_recovery_reconciliation_v2(uuid, uuid, uuid, text, text, text, text, integer, uuid, bigint, text)', 'search_path=""', true, true),
    ('public.reject_billing_provider_recovery_source_drift_v2(uuid, uuid, uuid, text, text, text, text, integer, uuid, bigint, text)', 'search_path=""', true, true),
    ('public.read_billing_enrollment_item_schedule_identity_v31(uuid, uuid)', 'search_path=""', true, true),
    ('public.reject_billing_autopay_activation_without_provider_v31(uuid, uuid, uuid, uuid, uuid, uuid, text, text, text, integer, uuid, text, text, bigint)', 'search_path=""', true, true),
    ('public.reserve_billing_autopay_activation_v31(uuid, uuid, uuid, uuid, uuid, text, integer, text, text, numeric)', 'search_path=""', true, true),
    ('private.koaryu_release_resource_ownership_manifest_v31()', 'search_path=pg_catalog', false, false),
    ('private.koaryu_release_operational_contract_v31()', 'search_path=pg_catalog,TimeZone=UTC', false, false),
    ('private.koaryu_release_operational_manifest_v12()', 'search_path=pg_catalog,TimeZone=UTC', false, false),
    ('public.koaryu_release_schema_preflight_v7()', 'search_path=pg_catalog', true, true),
    ('public.koaryu_release_schema_preflight_v8()', 'search_path=pg_catalog', true, true),
    ('public.koaryu_release_schema_preflight_v9()', 'search_path=pg_catalog', true, true),
    ('public.koaryu_release_schema_preflight_v10()', 'search_path=pg_catalog', true, true),
    ('public.koaryu_release_schema_preflight_v11()', 'search_path=pg_catalog', true, true),
    ('public.koaryu_release_schema_preflight_v12()', 'search_path=pg_catalog', true, true)
  ) as v31(signature, search_path_config, security_definer, service_execute)
   where to_regprocedure('public.koaryu_release_schema_preflight_v12()') is not null
  union all
  select * from (values
    ('private.koaryu_release_invoice_retry_preread_manifest_v32()', 'search_path=pg_catalog', false, false),
    ('public.release_billing_invoice_retry_preread_lease_v32(uuid, uuid, uuid, text, text, text, integer, uuid, bigint)', 'search_path=""', true, true),
    ('public.koaryu_release_schema_preflight_v13()', 'search_path=pg_catalog', true, true)
  ) as v32(signature, search_path_config, security_definer, service_execute)
   where to_regprocedure('public.koaryu_release_schema_preflight_v13()') is not null
  union all
  select * from (values
    ('private.billing_invoice_retry_base_hash_v33(uuid, uuid, text, text, integer)','search_path=pg_catalog',false,false),
    ('private.billing_invoice_retry_preread_zero_evidence_v33(billing_provider_operations, text)','search_path=""',false,false),
    ('private.capture_billing_invoice_retry_hash_v33(uuid, uuid, uuid, uuid, uuid, text)','search_path=""',true,false),
    ('private.capture_billing_invoice_retry_resource_v33()','search_path=""',true,false),
    ('private.capture_billing_invoice_retry_alias_v33()','search_path=""',true,false),
    ('private.preserve_billing_invoice_retry_hash_ledger_v33()','search_path=""',false,false),
    ('private.handle_invoice_retry_consent_change_v33(uuid, uuid)','search_path=""',true,false),
    ('private.koaryu_release_invoice_retry_compatibility_manifest_v33()','search_path=pg_catalog',false,false),
    ('public.release_billing_invoice_retry_preread_lease_v33(uuid, uuid, uuid, text, text, text, integer, uuid, bigint, text)','search_path=""',true,true),
    ('public.finalize_billing_invoice_retry_hash_capture_v33(bigint, text, text)','search_path=""',true,true),
    ('public.koaryu_release_schema_preflight_v15()','search_path=pg_catalog',true,true)
  ) as v33(signature,search_path_config,security_definer,service_execute)
   where to_regprocedure('public.koaryu_release_schema_preflight_v15()') is not null
  union all
  select * from (values
    ('public.koaryu_release_schema_preflight_v16()','search_path=pg_catalog',true,true)
  ) as v35(signature,search_path_config,security_definer,service_execute)
   where to_regprocedure('public.koaryu_release_schema_preflight_v16()') is not null
  union all
  select * from (values
    ('private.koaryu_release_payer_setup_recovery_manifest_v36()','search_path=""',true,false),
    ('public.koaryu_release_schema_preflight_v17()','search_path=pg_catalog',true,true)
  ) as v36(signature,search_path_config,security_definer,service_execute)
   where to_regprocedure('public.koaryu_release_schema_preflight_v17()') is not null
),
required_writer_results(signature, expected_result_contract) as (
  values
    ('public.write_student_profile_atomic(uuid, uuid, uuid, jsonb, uuid[], jsonb, boolean, text)', 'students'),
    ('private.write_student_profile_atomic(uuid, uuid, uuid, jsonb, uuid[], jsonb, boolean, text)', 'students'),
    ('public.import_student_row_atomic(jsonb, uuid, uuid, text, integer, text, text, text, text, uuid[])', 'TABLE(student_id uuid, guardian_imported boolean)'),
    ('private.import_student_row_atomic(jsonb, uuid, uuid, text, integer, text, text, text, text, uuid[])', 'TABLE(student_id uuid, guardian_imported boolean)')
),
function_actual as (
  select format('%I.%I(%s)', namespace.nspname, function.proname, oidvectortypes(function.proargtypes)) as signature,
         owner.rolname as owner_name, language.lanname as language_name,
         function.prosecdef as security_definer,
         coalesce(array_to_string(function.proconfig, ','), '') as search_path_config,
         replace(pg_get_function_result(function.oid), 'public.', '') as result_contract,
         exists (select 1 from aclexplode(coalesce(function.proacl, acldefault('f', function.proowner))) acl where acl.grantee = 0 and acl.privilege_type = 'EXECUTE') as public_execute,
         has_function_privilege('anon', function.oid, 'EXECUTE') as anon_execute,
         has_function_privilege('authenticated', function.oid, 'EXECUTE') as authenticated_execute,
         has_function_privilege('service_role', function.oid, 'EXECUTE') as service_execute,
         encode(extensions.digest(convert_to(function.prosrc, 'UTF8'), 'sha256'), 'hex') as body_sha256,
         coalesce((
           select string_agg(
                    coalesce(grantor.rolname, 'PUBLIC') || '>' ||
                    coalesce(grantee.rolname, 'PUBLIC') || ':' || acl.privilege_type || ':' || acl.is_grantable::text,
                    ',' order by coalesce(grantor.rolname, 'PUBLIC') collate "C", coalesce(grantee.rolname, 'PUBLIC') collate "C", acl.privilege_type collate "C", acl.is_grantable
                  )
             from aclexplode(coalesce(function.proacl, acldefault('f', function.proowner))) acl
             left join pg_roles grantor on grantor.oid = acl.grantor
             left join pg_roles grantee on grantee.oid = acl.grantee
         ), '') as acl_state,
         exists (
           select 1
             from aclexplode(coalesce(function.proacl, acldefault('f', function.proowner))) acl
             left join pg_roles grantee on grantee.oid = acl.grantee
            where acl.privilege_type = 'EXECUTE'
              and acl.grantee <> function.proowner
              and not (
                grantee.rolname = 'service_role'
                and required.service_execute
                and not acl.is_grantable
              )
         ) as unexpected_execute_grant
    from pg_proc function
    join pg_namespace namespace on namespace.oid = function.pronamespace
    join pg_roles owner on owner.oid = function.proowner
    join pg_language language on language.oid = function.prolang
    join required_functions required
      on required.signature = format('%I.%I(%s)', namespace.nspname, function.proname, oidvectortypes(function.proargtypes))
),
function_compared as (
  select required.*, actual.owner_name, actual.language_name,
         actual.security_definer as actual_security_definer,
         actual.search_path_config as actual_search_path_config,
         actual.public_execute, actual.anon_execute, actual.authenticated_execute,
         actual.service_execute as actual_service_execute,
         actual.result_contract, writer_result.expected_result_contract,
         actual.body_sha256, actual.acl_state, actual.unexpected_execute_grant
    from required_functions required
    left join function_actual actual using (signature)
    left join required_writer_results writer_result using (signature)
),
base_required_triggers(table_name, trigger_name, function_schema, function_name, trigger_type) as (
  values
    ('studio_subscriptions', 'preserve_studio_comp_provenance_on_metadata_update', 'public', 'preserve_studio_comp_provenance', 19),
    ('studio_live_billing_authorizations', 'set_studio_live_billing_authorizations_updated_at', 'public', 'update_updated_at_column', 19),
    ('stripe_connect_account_dispositions', 'set_stripe_connect_account_dispositions_updated_at', 'public', 'update_updated_at_column', 19),
    ('studio_live_billing_authorizations', 'bind_live_billing_authorization_checkpoint', 'private', 'bind_live_billing_authorization_checkpoint', 23),
    ('stripe_connect_onboarding_bootstraps', 'set_stripe_connect_onboarding_bootstraps_updated_at', 'public', 'update_updated_at_column', 19),
    ('stripe_live_billing_reconciliation_checkpoints', 'enforce_live_billing_checkpoint_processed_events', 'private', 'enforce_live_billing_checkpoint_processed_events', 7),
    ('operational_alert_delivery_attempts', 'prevent_operational_alert_attempt_mutation', 'public', 'prevent_operational_alert_append_only_mutation', 27),
    ('operational_alert_delivery_outcomes', 'prevent_operational_alert_outcome_mutation', 'public', 'prevent_operational_alert_append_only_mutation', 27),
    ('operational_alert_audit_events', 'prevent_operational_alert_audit_mutation', 'public', 'prevent_operational_alert_append_only_mutation', 27),
    ('operational_alert_outbox', 'enforce_operational_alert_sent_receipt', 'public', 'enforce_operational_alert_sent_receipt', 23),
    ('studio_payment_accounts', 'sync_connect_identity_mapping_guard', 'private', 'sync_connect_identity_mapping_guard', 29),
    ('stripe_connect_account_dispositions', 'sync_connect_identity_exclusion_guard', 'private', 'sync_connect_identity_exclusion_guard', 29)
),
required_triggers(table_name, trigger_name, function_schema, function_name, trigger_type) as (
  select * from base_required_triggers
  union all
  select * from (values
    ('billing_invoice_mutation_owners', 'preserve_billing_invoice_mutation_owner_v31', 'private', 'preserve_billing_invoice_mutation_owner_v31', 19),
    ('billing_provider_operation_resources', 'maintain_billing_invoice_mutation_owner_v31', 'private', 'maintain_billing_invoice_mutation_owner_v31', 21)
  ) as v31(table_name, trigger_name, function_schema, function_name, trigger_type)
   where to_regprocedure('public.koaryu_release_schema_preflight_v12()') is not null
),
trigger_actual as (
  select relation.relname as table_name, trigger.tgname as trigger_name,
         function_namespace.nspname as function_schema, function.proname as function_name,
         trigger.tgtype::integer as trigger_type, trigger.tgenabled, trigger.tgisinternal,
         encode(extensions.digest(convert_to(pg_get_triggerdef(trigger.oid), 'UTF8'), 'sha256'), 'hex') as definition_sha256
    from pg_trigger trigger
    join pg_class relation on relation.oid = trigger.tgrelid
    join pg_namespace namespace on namespace.oid = relation.relnamespace
    join pg_proc function on function.oid = trigger.tgfoid
    join pg_namespace function_namespace on function_namespace.oid = function.pronamespace
    join required_triggers required
      on required.table_name = relation.relname and required.trigger_name = trigger.tgname
    cross join runtime_settings
   where namespace.nspname = 'public'
),
trigger_compared as (
  select required.*, actual.function_schema as actual_function_schema,
         actual.function_name as actual_function_name,
         actual.trigger_type as actual_trigger_type,
         actual.tgenabled, actual.tgisinternal, actual.definition_sha256
    from required_triggers required
    left join trigger_actual actual using (table_name, trigger_name)
),
required_indexes(index_name, table_name, unique_index, partial_index) as (
  values
    ('idx_studio_live_billing_authorizations_enabled', 'studio_live_billing_authorizations', false, true),
    ('idx_stripe_live_billing_reconciliation_checkpoints_latest', 'stripe_live_billing_reconciliation_checkpoints', false, false),
    ('idx_stripe_events_error_reference', 'stripe_events', true, true),
    ('idx_stripe_events_live_billing_ingest_sequence', 'stripe_events', true, false),
    ('idx_stripe_connect_onboarding_bootstraps_generation_once', 'stripe_connect_onboarding_bootstraps', true, false),
    ('idx_stripe_connect_onboarding_bootstraps_delivery_receipt', 'stripe_connect_onboarding_bootstraps', true, true),
    ('operational_alert_episodes_one_unresolved', 'operational_alert_episodes', true, true),
    ('operational_alert_episodes_recent', 'operational_alert_episodes', false, false),
    ('operational_alert_outbox_claim', 'operational_alert_outbox', false, true),
    ('operational_alert_delivery_attempts_delivery', 'operational_alert_delivery_attempts', false, false),
    ('operational_alert_audit_events_episode', 'operational_alert_audit_events', false, false),
    ('promotions_studio_operation_once', 'promotions', true, true)
),
index_actual as (
  select index_relation.relname as index_name, table_relation.relname as table_name,
         index.indisunique as unique_index, index.indpred is not null as partial_index,
         index.indisvalid, index.indisready,
         encode(extensions.digest(convert_to(pg_get_indexdef(index.indexrelid), 'UTF8'), 'sha256'), 'hex') as definition_sha256
    from pg_index index
    join pg_class index_relation on index_relation.oid = index.indexrelid
    join pg_class table_relation on table_relation.oid = index.indrelid
    join pg_namespace namespace on namespace.oid = table_relation.relnamespace
    join required_indexes required on required.index_name = index_relation.relname
    cross join runtime_settings
   where namespace.nspname = 'public'
),
index_compared as (
  select required.*, actual.table_name as actual_table_name,
         actual.unique_index as actual_unique_index,
         actual.partial_index as actual_partial_index,
         actual.indisvalid, actual.indisready, actual.definition_sha256
    from required_indexes required
    left join index_actual actual using (index_name)
),
required_sequences(table_name, column_name, service_usage, service_select, service_update) as (
  values
    ('stripe_live_billing_reconciliation_checkpoints', 'checkpoint_sequence', true, true, false),
    ('stripe_events', 'live_billing_ingest_sequence', true, true, false),
    ('operational_alert_audit_events', 'id', true, true, false)
),
sequence_actual as (
  select table_relation.relname as table_name, attribute.attname as column_name,
         owner.rolname as owner_name,
         coalesce((
           select string_agg(
                    coalesce(grantor.rolname, 'PUBLIC') || '>' ||
                    coalesce(grantee.rolname, 'PUBLIC') || ':' || acl.privilege_type || ':' || acl.is_grantable::text,
                    ',' order by coalesce(grantor.rolname, 'PUBLIC') collate "C", coalesce(grantee.rolname, 'PUBLIC') collate "C", acl.privilege_type collate "C", acl.is_grantable
                  )
             from aclexplode(coalesce(sequence.relacl, acldefault('S', sequence.relowner))) acl
             left join pg_roles grantor on grantor.oid = acl.grantor
             left join pg_roles grantee on grantee.oid = acl.grantee
         ), '') as acl_state,
         exists (select 1 from aclexplode(coalesce(sequence.relacl, acldefault('S', sequence.relowner))) acl where acl.grantee = 0) as public_access,
         has_sequence_privilege('anon', sequence.oid, 'USAGE,SELECT,UPDATE') as anon_access,
         has_sequence_privilege('authenticated', sequence.oid, 'USAGE,SELECT,UPDATE') as authenticated_access,
         has_sequence_privilege('service_role', sequence.oid, 'USAGE') as service_usage,
         has_sequence_privilege('service_role', sequence.oid, 'SELECT') as service_select,
         has_sequence_privilege('service_role', sequence.oid, 'UPDATE') as service_update
    from pg_class sequence
    join pg_depend dependency on dependency.objid = sequence.oid and dependency.deptype in ('a', 'i')
    join pg_class table_relation on table_relation.oid = dependency.refobjid
    join pg_attribute attribute on attribute.attrelid = table_relation.oid and attribute.attnum = dependency.refobjsubid
    join pg_namespace namespace on namespace.oid = table_relation.relnamespace
    join pg_roles owner on owner.oid = sequence.relowner
    join required_sequences required on required.table_name = table_relation.relname and required.column_name = attribute.attname
   where namespace.nspname = 'public' and sequence.relkind = 'S'
),
sequence_compared as (
  select required.*, actual.owner_name, actual.public_access,
         actual.anon_access, actual.authenticated_access,
         actual.service_usage as actual_service_usage,
         actual.service_select as actual_service_select,
         actual.service_update as actual_service_update,
         actual.acl_state
    from required_sequences required
    left join sequence_actual actual using (table_name, column_name)
),
base_required_columns(table_name, column_name, data_type, nullable, identity_column) as (
  values
    ('stripe_events', 'error_reference', 'text', true, false),
    ('stripe_events', 'live_billing_ingest_sequence', 'bigint', false, true),
    ('stripe_live_billing_reconciliation_checkpoints', 'evidence_source', 'text', true, false),
    ('stripe_live_billing_reconciliation_checkpoints', 'deployment_ready_url', 'text', true, false),
    ('stripe_live_billing_reconciliation_checkpoints', 'deployment_ready_sha', 'text', true, false),
    ('stripe_live_billing_reconciliation_checkpoints', 'deployment_ready_verified_at', 'timestamp with time zone', true, false),
    ('stripe_live_billing_reconciliation_checkpoints', 'event_window_started_at', 'timestamp with time zone', true, false),
    ('stripe_live_billing_reconciliation_checkpoints', 'event_window_ended_at', 'timestamp with time zone', true, false),
    ('stripe_live_billing_reconciliation_checkpoints', 'local_event_ingest_watermark', 'bigint', true, false),
    ('stripe_live_billing_reconciliation_checkpoints', 'bounded_provider_event_count', 'integer', true, false),
    ('stripe_live_billing_reconciliation_checkpoints', 'bounded_local_event_count', 'integer', true, false),
    ('stripe_live_billing_reconciliation_checkpoints', 'provider_only_event_count', 'integer', true, false),
    ('stripe_live_billing_reconciliation_checkpoints', 'local_only_event_count', 'integer', true, false),
    ('stripe_live_billing_reconciliation_checkpoints', 'platform_provider_event_count', 'integer', true, false),
    ('stripe_live_billing_reconciliation_checkpoints', 'platform_local_event_count', 'integer', true, false),
    ('stripe_live_billing_reconciliation_checkpoints', 'platform_delivery_verified_at', 'timestamp with time zone', true, false),
    ('stripe_live_billing_reconciliation_checkpoints', 'unexpected_enabled_endpoint_count', 'integer', true, false),
    ('stripe_live_billing_reconciliation_checkpoints', 'account_evidence_count', 'integer', true, false),
    ('studio_live_billing_authorizations', 'reconciliation_checkpoint_id', 'uuid', true, false),
    ('studio_live_billing_authorizations', 'local_event_ingest_watermark', 'bigint', true, false),
    ('stripe_connect_onboarding_bootstraps', 'bootstrap_token_sha256', 'text', false, false),
    ('stripe_connect_onboarding_bootstraps', 'connect_account_generation', 'integer', false, false),
    ('stripe_connect_onboarding_bootstraps', 'initial_link_payload_sha256', 'text', true, false),
    ('stripe_connect_onboarding_bootstraps', 'stripe_connected_account_id', 'text', true, false),
    ('stripe_connect_onboarding_bootstraps', 'expires_at', 'timestamp with time zone', false, false),
    ('stripe_connect_onboarding_bootstraps', 'initial_link_claimed_at', 'timestamp with time zone', true, false),
    ('stripe_connect_onboarding_bootstraps', 'recovery_context', 'jsonb', true, false),
    ('stripe_connect_onboarding_bootstraps', 'recovery_expires_at', 'timestamp with time zone', true, false),
    ('stripe_connect_onboarding_bootstraps', 'initial_link_response_sha256', 'text', true, false),
    ('stripe_connect_onboarding_bootstraps', 'initial_link_response_recorded_at', 'timestamp with time zone', true, false),
    ('stripe_connect_onboarding_bootstraps', 'initial_link_delivery_receipt_sha256', 'text', true, false),
    ('stripe_connect_onboarding_bootstraps', 'initial_link_delivery_receipt_expires_at', 'timestamp with time zone', true, false),
    ('stripe_connect_onboarding_bootstraps', 'initial_link_delivered_at', 'timestamp with time zone', true, false),
    ('stripe_connect_onboarding_bootstraps', 'initial_link_support_required_at', 'timestamp with time zone', true, false),
    ('operational_alert_episodes', 'backup_destination_id', 'text', false, false),
    ('operational_alert_episodes', 'escalation_after_minutes', 'integer', false, false),
    ('operational_alert_episodes', 'acknowledged_at', 'timestamp with time zone', true, false),
    ('operational_alert_episodes', 'acknowledged_by_role', 'text', true, false),
    ('operational_alert_episodes', 'acknowledged_actor_ref', 'text', true, false),
    ('operational_alert_outbox', 'event_kind', 'text', false, false),
    ('operational_alert_outbox', 'destination_role', 'text', false, false),
    ('promotions', 'operation_id', 'uuid', true, false),
    ('promotions', 'transition_kind', 'text', true, false)
),
required_columns(table_name, column_name, data_type, nullable, identity_column) as (
  select * from base_required_columns
  union all
  select 'studio_live_billing_authorizations', 'allowed_operations', 'ARRAY', false, false
   where to_regprocedure('public.koaryu_release_schema_preflight_v11()') is not null
),
column_compared as (
  select required.*,
         actual.data_type as actual_data_type,
         actual.is_nullable = 'YES' as actual_nullable,
         actual.is_identity = 'YES' as actual_identity_column
    from required_columns required
    left join information_schema.columns actual
      on actual.table_schema = 'public'
     and actual.table_name = required.table_name
     and actual.column_name = required.column_name
),
base_required_constraints(table_name, constraint_identity, constraint_type) as (
  values
    ('stripe_live_billing_reconciliation_checkpoints', 'stripe_live_checkpoint_source_contract', 'c'),
    ('stripe_live_billing_reconciliation_checkpoints', 'stripe_live_checkpoint_ready_url_contract', 'c'),
    ('stripe_live_billing_reconciliation_checkpoints', 'stripe_live_checkpoint_ready_sha_contract', 'c'),
    ('stripe_live_billing_reconciliation_checkpoints', 'stripe_live_checkpoint_window_contract', 'c'),
    ('stripe_live_billing_reconciliation_checkpoints', 'stripe_live_checkpoint_watermark_contract', 'c'),
    ('stripe_live_billing_reconciliation_checkpoints', 'stripe_live_checkpoint_gap_contract', 'c'),
    ('studio_live_billing_authorizations', 'studio_live_billing_checkpoint_binding', 'c'),
    ('stripe_live_billing_reconciliation_account_evidence', 'primary:checkpoint_id,stripe_connected_account_id', 'p'),
    ('stripe_live_billing_reconciliation_account_evidence', 'unique:checkpoint_id,studio_id', 'u'),
    ('operational_alert_episodes', 'operational_alert_episode_ack_complete', 'c'),
    ('promotions', 'promotions_transition_kind_check', 'c'),
    ('operational_alert_outbox', 'operational_alert_outbox_episode_event_role_key', 'u'),
    ('operational_alert_audit_events', 'operational_alert_audit_events_event_type_check', 'c'),
    ('stripe_connect_onboarding_bootstraps', 'stripe_connect_onboarding_bootstraps_recovery_pair', 'c'),
    ('stripe_connect_onboarding_bootstraps', 'stripe_connect_onboarding_bootstraps_recovery_context_object', 'c'),
    ('stripe_connect_onboarding_bootstraps', 'stripe_connect_onboarding_bootstraps_recovery_expiry', 'c'),
    ('stripe_connect_onboarding_bootstraps', 'stripe_connect_onboarding_bootstraps_response_hash', 'c'),
    ('stripe_connect_onboarding_bootstraps', 'stripe_connect_onboarding_bootstraps_receipt_hash', 'c'),
    ('stripe_connect_onboarding_bootstraps', 'stripe_connect_onboarding_bootstraps_response_pair', 'c'),
    ('stripe_connect_onboarding_bootstraps', 'stripe_connect_onboarding_bootstraps_receipt_pair', 'c'),
    ('stripe_connect_onboarding_bootstraps', 'stripe_connect_onboarding_bootstraps_delivery_order', 'c'),
    ('stripe_connect_onboarding_bootstraps', 'stripe_connect_onboarding_bootstraps_receipt_expiry', 'c'),
    ('stripe_connect_onboarding_bootstraps', 'stripe_connect_onboarding_bootstraps_delivered_state', 'c'),
    ('stripe_connect_onboarding_bootstraps', 'stripe_connect_onboarding_bootstraps_terminal_state', 'c')
),
required_constraints(table_name, constraint_identity, constraint_type) as (
  select * from base_required_constraints
  union all
  select 'studio_live_billing_authorizations',
         'studio_live_billing_authorizations_operation_set_exact', 'c'
   where to_regprocedure('public.koaryu_release_schema_preflight_v11()') is not null
),
constraint_actual as (
  select relation.relname as table_name,
         case
           when relation.relname = 'stripe_live_billing_reconciliation_account_evidence'
            and constraint_state.contype = 'p'
             then 'primary:' || columns.column_names
           when relation.relname = 'stripe_live_billing_reconciliation_account_evidence'
            and constraint_state.contype = 'u'
             then 'unique:' || columns.column_names
           else constraint_state.conname
         end as constraint_identity,
         constraint_state.contype::text as constraint_type,
         constraint_state.convalidated,
         encode(extensions.digest(convert_to(pg_get_constraintdef(constraint_state.oid), 'UTF8'), 'sha256'), 'hex') as definition_sha256
    from pg_constraint constraint_state
    join pg_class relation on relation.oid = constraint_state.conrelid
    join pg_namespace namespace on namespace.oid = relation.relnamespace
    left join lateral (
      select string_agg(attribute.attname, ',' order by key_position.ordinality) as column_names
        from unnest(constraint_state.conkey) with ordinality key_position(attnum, ordinality)
        join pg_attribute attribute
          on attribute.attrelid = constraint_state.conrelid
         and attribute.attnum = key_position.attnum
    ) columns on true
    cross join runtime_settings
   where namespace.nspname = 'public'
),
constraint_compared as (
  select required.*,
         actual.constraint_type as actual_constraint_type,
         actual.convalidated, actual.definition_sha256
    from required_constraints required
    left join constraint_actual actual using (table_name, constraint_identity)
),
scoped_index_definitions as (
  select namespace.nspname as schema_name, table_relation.relname as table_name,
         index_relation.relname as index_name,
         encode(extensions.digest(convert_to(pg_get_indexdef(index_state.indexrelid), 'UTF8'), 'sha256'), 'hex') as definition_sha256
    from pg_index index_state
    join pg_class index_relation on index_relation.oid = index_state.indexrelid
    join pg_class table_relation on table_relation.oid = index_state.indrelid
    join pg_namespace namespace on namespace.oid = table_relation.relnamespace
    join scoped_definition_tables covered
      on covered.schema_name = namespace.nspname and covered.table_name = table_relation.relname
    cross join runtime_settings
),
scoped_constraint_definitions as (
  select namespace.nspname as schema_name, relation.relname as table_name,
         constraint_state.conname as constraint_name,
         constraint_state.contype::text as constraint_type,
         constraint_state.convalidated,
         encode(extensions.digest(convert_to(pg_get_constraintdef(constraint_state.oid), 'UTF8'), 'sha256'), 'hex') as definition_sha256
    from pg_constraint constraint_state
    join pg_class relation on relation.oid = constraint_state.conrelid
    join pg_namespace namespace on namespace.oid = relation.relnamespace
    join scoped_definition_tables covered
      on covered.schema_name = namespace.nspname and covered.table_name = relation.relname
    cross join runtime_settings
),
states as (
  select 'tables' as category, count(*)::integer as object_count,
         encode(extensions.digest(convert_to(coalesce(string_agg(schema_name || '.' || table_name || ':' || coalesce(owner_name, '') || ':' || coalesce(relrowsecurity::text, '') || ':' || coalesce(actual_service_privileges, '') || ':' || coalesce(acl_state, ''), '|' order by schema_name collate "C", table_name collate "C"), ''), 'UTF8'), 'sha256'), 'hex') as state_digest,
         count(*) filter (where owner_name is null or owner_name <> 'postgres' or relrowsecurity is distinct from rls_enabled or public_access or anon_access or authenticated_access or actual_service_privileges is distinct from service_privileges)::integer as failures
    from table_compared
  union all
  select 'table_acls', count(*)::integer,
         encode(extensions.digest(convert_to(coalesce(string_agg(schema_name || '.' || table_name || ':' || owner_name || ':' || acl_state, '|' order by schema_name collate "C", table_name collate "C"), ''), 'UTF8'), 'sha256'), 'hex'),
         0::integer
    from table_acl_definitions
  union all
  select 'column_acls', count(*)::integer,
         encode(extensions.digest(convert_to(coalesce(string_agg(schema_name || '.' || table_name || ':' || attnum::text || ':' || column_name || ':' || acl_state, '|' order by schema_name collate "C", table_name collate "C", attnum), ''), 'UTF8'), 'sha256'), 'hex'),
         0::integer
    from column_acl_definitions
  union all
  select 'policies', count(*)::integer,
         encode(extensions.digest(convert_to(coalesce(string_agg(table_name || ':' || policy_name || ':' || coalesce(actual_permissive::text, '') || ':' || coalesce(actual_command_name, '') || ':' || coalesce(actual_role_names, '') || ':' || coalesce(actual_predicate_kind, ''), '|' order by table_name collate "C", policy_name collate "C"), ''), 'UTF8'), 'sha256'), 'hex'),
         count(*) filter (where not expected_policy or not actual_policy or actual_permissive is distinct from permissive or actual_command_name is distinct from command_name or actual_role_names is distinct from role_names or actual_predicate_kind is distinct from predicate_kind)::integer
    from policy_compared
  union all
  select 'functions', count(*)::integer,
         encode(extensions.digest(convert_to(coalesce(string_agg(signature || ':' || coalesce(owner_name, '') || ':' || coalesce(language_name, '') || ':' || coalesce(actual_security_definer::text, '') || ':' || coalesce(actual_search_path_config, '') || ':' || coalesce(actual_service_execute::text, '') || ':' || coalesce(result_contract, '') || ':' || coalesce(body_sha256, '') || ':' || coalesce(acl_state, ''), '|' order by signature collate "C"), ''), 'UTF8'), 'sha256'), 'hex'),
         count(*) filter (where owner_name is null or owner_name <> 'postgres' or language_name not in ('sql', 'plpgsql') or actual_security_definer is distinct from security_definer or actual_search_path_config is distinct from search_path_config or public_execute or anon_execute or authenticated_execute or actual_service_execute is distinct from service_execute or unexpected_execute_grant or (expected_result_contract is not null and result_contract is distinct from expected_result_contract))::integer
    from function_compared
  union all
  select 'triggers', count(*)::integer,
         encode(extensions.digest(convert_to(coalesce(string_agg(table_name || ':' || trigger_name || ':' || coalesce(actual_function_schema, '') || '.' || coalesce(actual_function_name, '') || ':' || coalesce(actual_trigger_type::text, '') || ':' || coalesce(tgenabled::text, '') || ':' || coalesce(definition_sha256, ''), '|' order by table_name collate "C", trigger_name collate "C"), ''), 'UTF8'), 'sha256'), 'hex'),
         count(*) filter (where actual_function_schema is distinct from function_schema or actual_function_name is distinct from function_name or actual_trigger_type is distinct from trigger_type or tgenabled is distinct from 'O' or tgisinternal is distinct from false)::integer
    from trigger_compared
  union all
  select 'indexes', count(*)::integer,
         encode(extensions.digest(convert_to(coalesce(string_agg(index_name || ':' || coalesce(actual_table_name, '') || ':' || coalesce(actual_unique_index::text, '') || ':' || coalesce(actual_partial_index::text, '') || ':' || coalesce(indisvalid::text, '') || ':' || coalesce(indisready::text, '') || ':' || coalesce(definition_sha256, ''), '|' order by index_name collate "C"), ''), 'UTF8'), 'sha256'), 'hex'),
         count(*) filter (where actual_table_name is distinct from table_name or actual_unique_index is distinct from unique_index or actual_partial_index is distinct from partial_index or indisvalid is distinct from true or indisready is distinct from true)::integer
    from index_compared
  union all
  select 'sequences', count(*)::integer,
         encode(extensions.digest(convert_to(coalesce(string_agg(table_name || '.' || column_name || ':' || coalesce(owner_name, '') || ':' || coalesce(actual_service_usage::text, '') || ':' || coalesce(actual_service_select::text, '') || ':' || coalesce(actual_service_update::text, '') || ':' || coalesce(acl_state, ''), '|' order by table_name collate "C", column_name collate "C"), ''), 'UTF8'), 'sha256'), 'hex'),
         count(*) filter (where owner_name is null or owner_name <> 'postgres' or public_access or anon_access or authenticated_access or actual_service_usage is distinct from service_usage or actual_service_select is distinct from service_select or actual_service_update is distinct from service_update)::integer
    from sequence_compared
  union all
  select 'columns', count(*)::integer,
         encode(extensions.digest(convert_to(coalesce(string_agg(table_name || '.' || column_name || ':' || coalesce(actual_data_type, '') || ':' || coalesce(actual_nullable::text, '') || ':' || coalesce(actual_identity_column::text, ''), '|' order by table_name collate "C", column_name collate "C"), ''), 'UTF8'), 'sha256'), 'hex'),
         count(*) filter (where actual_data_type is distinct from data_type or actual_nullable is distinct from nullable or actual_identity_column is distinct from identity_column)::integer
    from column_compared
  union all
  select 'constraints', count(*)::integer,
         encode(extensions.digest(convert_to(coalesce(string_agg(table_name || ':' || constraint_identity || ':' || coalesce(actual_constraint_type, '') || ':' || coalesce(convalidated::text, '') || ':' || coalesce(definition_sha256, ''), '|' order by table_name collate "C", constraint_identity collate "C"), ''), 'UTF8'), 'sha256'), 'hex'),
         count(*) filter (where actual_constraint_type is distinct from constraint_type or convalidated is distinct from true)::integer
    from constraint_compared
  union all
  select 'scoped_indexes', count(*)::integer,
         encode(extensions.digest(convert_to(coalesce(string_agg(schema_name || '.' || table_name || ':' || index_name || ':' || definition_sha256, '|' order by schema_name collate "C", table_name collate "C", index_name collate "C"), ''), 'UTF8'), 'sha256'), 'hex'),
         0::integer
    from scoped_index_definitions
  union all
  select 'scoped_constraints', count(*)::integer,
         encode(extensions.digest(convert_to(coalesce(string_agg(schema_name || '.' || table_name || ':' || constraint_name || ':' || constraint_type || ':' || convalidated::text || ':' || definition_sha256, '|' order by schema_name collate "C", table_name collate "C", constraint_name collate "C"), ''), 'UTF8'), 'sha256'), 'hex'),
         count(*) filter (where not convalidated)::integer
    from scoped_constraint_definitions
)
select string_agg(category || '=' || object_count::text || ':' || state_digest || ':' || failures::text, ';' order by category collate "C") as catalog_state
from states
`;

class RolloutError extends Error {}

function digest(algorithm, value) {
  return createHash(algorithm).update(value).digest("hex");
}

function hashFile(filename) {
  return digest("sha256", fs.readFileSync(filename));
}

function assertPlainText(name, value) {
  if (typeof value !== "string" || value.length === 0) {
    throw new RolloutError(`${name} is required.`);
  }
  if (!/^[\x20-\x7e]+$/.test(value) || value.trim() !== value) {
    throw new RolloutError(`${name} must be plain printable ASCII without surrounding whitespace.`);
  }
  return value;
}

export const SCHEDULE_V25_CATALOG_STATE_SQL = `
with runtime_settings as materialized (
  select set_config('TimeZone', 'UTC', true)
),
required_tables(schema_name, table_name, rls_enabled, service_privileges) as (
  values
    ('public', 'studio_live_billing_authorizations', true, 'SELECT'),
    ('public', 'stripe_live_billing_reconciliation_checkpoints', true, 'SELECT'),
    ('public', 'stripe_connect_account_dispositions', true, 'SELECT'),
    ('public', 'stripe_live_billing_reconciliation_account_evidence', true, 'SELECT'),
    ('public', 'stripe_connect_onboarding_bootstraps', true, ''),
    ('public', 'operational_alert_episodes', true, 'INSERT,SELECT,UPDATE'),
    ('public', 'operational_alert_outbox', true, 'INSERT,SELECT,UPDATE'),
    ('public', 'operational_alert_delivery_attempts', true, 'INSERT,SELECT'),
    ('public', 'operational_alert_delivery_outcomes', true, 'INSERT,SELECT'),
    ('public', 'operational_alert_audit_events', true, 'INSERT,SELECT'),
    ('public', 'operational_alert_heartbeats', true, 'INSERT,SELECT,UPDATE'),
    ('private', 'stripe_connect_account_identity_guards', false, '')
),
acl_scope_tables(schema_name, table_name) as (
  select schema_name, table_name from required_tables
  union all
  values
    ('public', 'studio_payment_accounts'),
    ('public', 'stripe_events')
),
scoped_definition_tables(schema_name, table_name) as (
  select schema_name, table_name from required_tables
  union all
  select 'public', 'studio_payment_accounts'
),
table_actual as (
  select
    namespace.nspname as schema_name,
    relation.relname as table_name,
    owner.rolname as owner_name,
    relation.relrowsecurity,
    coalesce((
      select string_agg(
               coalesce(grantor.rolname, 'PUBLIC') || '>' ||
               coalesce(grantee.rolname, 'PUBLIC') || ':' || acl.privilege_type || ':' || acl.is_grantable::text,
               ',' order by coalesce(grantor.rolname, 'PUBLIC') collate "C", coalesce(grantee.rolname, 'PUBLIC') collate "C", acl.privilege_type collate "C", acl.is_grantable
             )
        from aclexplode(coalesce(relation.relacl, acldefault('r', relation.relowner))) acl
        left join pg_roles grantor on grantor.oid = acl.grantor
        left join pg_roles grantee on grantee.oid = acl.grantee
    ), '') as acl_state,
    exists (
      select 1
        from aclexplode(coalesce(relation.relacl, acldefault('r', relation.relowner))) acl
       where acl.grantee = 0
    ) as public_access,
    has_table_privilege('anon', relation.oid, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') as anon_access,
    has_table_privilege('authenticated', relation.oid, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') as authenticated_access,
    concat_ws(',',
      case when has_table_privilege('service_role', relation.oid, 'INSERT') then 'INSERT' end,
      case when has_table_privilege('service_role', relation.oid, 'SELECT') then 'SELECT' end,
      case when has_table_privilege('service_role', relation.oid, 'UPDATE') then 'UPDATE' end,
      case when has_table_privilege('service_role', relation.oid, 'DELETE') then 'DELETE' end,
      case when has_table_privilege('service_role', relation.oid, 'TRUNCATE') then 'TRUNCATE' end,
      case when has_table_privilege('service_role', relation.oid, 'REFERENCES') then 'REFERENCES' end,
      case when has_table_privilege('service_role', relation.oid, 'TRIGGER') then 'TRIGGER' end
    ) as service_privileges
  from pg_class relation
  join pg_namespace namespace on namespace.oid = relation.relnamespace
  join pg_roles owner on owner.oid = relation.relowner
  join required_tables required
    on required.schema_name = namespace.nspname and required.table_name = relation.relname
  where relation.relkind = 'r'
),
table_compared as (
  select required.*, actual.owner_name, actual.relrowsecurity,
         actual.public_access, actual.anon_access, actual.authenticated_access,
         actual.service_privileges as actual_service_privileges,
         actual.acl_state
    from required_tables required
    left join table_actual actual using (schema_name, table_name)
),
table_acl_definitions as (
  select namespace.nspname as schema_name, relation.relname as table_name,
         owner.rolname as owner_name,
         coalesce((
           select string_agg(
                    coalesce(grantor.rolname, 'PUBLIC') || '>' ||
                    coalesce(grantee.rolname, 'PUBLIC') || ':' || acl.privilege_type || ':' || acl.is_grantable::text,
                    ',' order by coalesce(grantor.rolname, 'PUBLIC') collate "C", coalesce(grantee.rolname, 'PUBLIC') collate "C", acl.privilege_type collate "C", acl.is_grantable
                  )
             from aclexplode(coalesce(relation.relacl, acldefault('r', relation.relowner))) acl
             left join pg_roles grantor on grantor.oid = acl.grantor
             left join pg_roles grantee on grantee.oid = acl.grantee
         ), '') as acl_state
    from pg_class relation
    join pg_namespace namespace on namespace.oid = relation.relnamespace
    join pg_roles owner on owner.oid = relation.relowner
    join acl_scope_tables covered
      on covered.schema_name = namespace.nspname and covered.table_name = relation.relname
   where relation.relkind = 'r'
),
column_acl_definitions as (
  select namespace.nspname as schema_name,
         relation.relname as table_name,
         attribute.attnum,
         attribute.attname as column_name,
         coalesce((
           select string_agg(
                    coalesce(grantor.rolname, 'PUBLIC') || '>' ||
                    coalesce(grantee.rolname, 'PUBLIC') || ':' ||
                    acl.privilege_type || ':' || acl.is_grantable::text,
                    ',' order by coalesce(grantor.rolname, 'PUBLIC') collate "C",
                                 coalesce(grantee.rolname, 'PUBLIC') collate "C",
                                 acl.privilege_type collate "C", acl.is_grantable
                  )
             from aclexplode(attribute.attacl) acl
             left join pg_roles grantor on grantor.oid = acl.grantor
             left join pg_roles grantee on grantee.oid = acl.grantee
         ), '') as acl_state
    from pg_class relation
    join pg_namespace namespace on namespace.oid = relation.relnamespace
    join acl_scope_tables covered
      on covered.schema_name = namespace.nspname and covered.table_name = relation.relname
    join pg_attribute attribute
      on attribute.attrelid = relation.oid
     and attribute.attnum > 0
     and not attribute.attisdropped
   where relation.relkind = 'r'
),
required_policies(table_name, policy_name, permissive, command_name, role_names, predicate_kind) as (
  values
    ('studio_live_billing_authorizations', 'studio_live_billing_authorizations_no_client_access', false, '*', 'anon,authenticated', 'deny_all'),
    ('studio_live_billing_authorizations', 'reject_ambiguous_staff_membership_access', false, '*', 'authenticated', 'membership_guard'),
    ('stripe_live_billing_reconciliation_checkpoints', 'stripe_live_billing_reconciliation_checkpoints_no_client_access', false, '*', 'anon,authenticated', 'deny_all'),
    ('stripe_live_billing_reconciliation_checkpoints', 'reject_ambiguous_staff_membership_access', false, '*', 'authenticated', 'membership_guard'),
    ('stripe_connect_account_dispositions', 'stripe_connect_account_dispositions_no_client_access', false, '*', 'anon,authenticated', 'deny_all'),
    ('stripe_connect_account_dispositions', 'reject_ambiguous_staff_membership_access', false, '*', 'authenticated', 'membership_guard'),
    ('stripe_live_billing_reconciliation_account_evidence', 'stripe_live_billing_account_evidence_no_client_access', false, '*', 'anon,authenticated', 'deny_all'),
    ('stripe_live_billing_reconciliation_account_evidence', 'reject_ambiguous_staff_membership_access', false, '*', 'authenticated', 'membership_guard'),
    ('stripe_connect_onboarding_bootstraps', 'stripe_connect_onboarding_bootstraps_no_client_access', false, '*', 'anon,authenticated', 'deny_all'),
    ('stripe_connect_onboarding_bootstraps', 'reject_ambiguous_staff_membership_access', false, '*', 'authenticated', 'membership_guard'),
    ('operational_alert_episodes', 'reject_ambiguous_staff_membership_access', false, '*', 'authenticated', 'membership_guard'),
    ('operational_alert_outbox', 'reject_ambiguous_staff_membership_access', false, '*', 'authenticated', 'membership_guard'),
    ('operational_alert_delivery_attempts', 'reject_ambiguous_staff_membership_access', false, '*', 'authenticated', 'membership_guard'),
    ('operational_alert_delivery_outcomes', 'reject_ambiguous_staff_membership_access', false, '*', 'authenticated', 'membership_guard'),
    ('operational_alert_audit_events', 'reject_ambiguous_staff_membership_access', false, '*', 'authenticated', 'membership_guard'),
    ('operational_alert_heartbeats', 'reject_ambiguous_staff_membership_access', false, '*', 'authenticated', 'membership_guard')
),
policy_actual as (
  select relation.relname as table_name, policy.polname as policy_name,
         policy.polpermissive as permissive, policy.polcmd::text as command_name,
         (select string_agg(role.rolname, ',' order by role.rolname collate "C")
            from unnest(policy.polroles) role_oid
            join pg_roles role on role.oid = role_oid) as role_names,
         case
           when regexp_replace(pg_get_expr(policy.polqual, policy.polrelid), '[[:space:]()]', '', 'g') = 'false'
            and regexp_replace(pg_get_expr(policy.polwithcheck, policy.polrelid), '[[:space:]()]', '', 'g') = 'false'
             then 'deny_all'
           when regexp_replace(
                  regexp_replace(pg_get_expr(policy.polqual, policy.polrelid), '[[:space:]()]', '', 'g'),
                  'AShas_unambiguous_studio_membership$', ''
                ) = 'SELECTprivate.has_unambiguous_studio_membership'
            and regexp_replace(
                  regexp_replace(pg_get_expr(policy.polwithcheck, policy.polrelid), '[[:space:]()]', '', 'g'),
                  'AShas_unambiguous_studio_membership$', ''
                ) = 'SELECTprivate.has_unambiguous_studio_membership'
             then 'membership_guard'
           else 'unexpected'
         end as predicate_kind
    from pg_policy policy
    join pg_class relation on relation.oid = policy.polrelid
    join pg_namespace namespace on namespace.oid = relation.relnamespace
    join required_tables covered
      on covered.schema_name = 'public' and covered.table_name = relation.relname
   where namespace.nspname = 'public'
),
policy_compared as (
  select coalesce(required.table_name, actual.table_name) as table_name,
         coalesce(required.policy_name, actual.policy_name) as policy_name,
         required.permissive, required.command_name, required.role_names,
         required.predicate_kind,
         actual.permissive as actual_permissive,
         actual.command_name as actual_command_name,
         actual.role_names as actual_role_names,
         actual.predicate_kind as actual_predicate_kind,
         required.table_name is not null as expected_policy,
         actual.table_name is not null as actual_policy
    from required_policies required
    full join policy_actual actual using (table_name, policy_name)
),
required_functions(signature, search_path_config, security_definer, service_execute) as (
  values
    ('public.preserve_studio_comp_provenance()', 'search_path=pg_catalog', false, false),
    ('public.set_studio_comp_atomic(uuid, boolean, text, uuid, text, boolean)', 'search_path=public, pg_temp', false, true),
    ('public.clear_studio_comp_for_billing_event(uuid, bigint)', 'search_path=public, pg_temp', false, true),
    ('public.record_stripe_live_billing_reconciliation_checkpoint(text, integer, integer, integer, integer, integer, integer, timestamp with time zone, timestamp with time zone, integer, integer, boolean, boolean, timestamp with time zone, text, text, uuid, text)', 'search_path=public, pg_temp', true, false),
    ('public.record_stripe_live_billing_reconciliation_checkpoint_v2(jsonb, timestamp with time zone, text, text, uuid, text)', 'search_path=""', true, true),
    ('public.authorize_studio_live_billing_mutation_atomic(uuid, text, text, text, text)', 'search_path=""', true, true),
    ('public.authorize_connect_onboarding_bootstrap_account_create(uuid, text, integer, text, text, text, text, text)', 'search_path=""', true, false),
    ('public.bind_connect_onboarding_bootstrap_account(uuid, text, integer, text, text, text)', 'search_path=""', true, false),
    ('public.authorize_connect_onboarding_bootstrap_initial_link(uuid, text, integer, text, text, text, text, text)', 'search_path=""', true, false),
    ('private.connect_onboarding_bootstrap_link_checkpoint(uuid, text)', 'search_path=""', true, false),
    ('public.preflight_connect_onboarding_bootstrap_begin(uuid, text)', 'search_path=""', true, true),
    ('public.preflight_connect_onboarding_bootstrap_resume(uuid, text)', 'search_path=""', true, true),
    ('public.prepare_connect_onboarding_bootstrap_atomic(uuid, text, integer, jsonb, text, text, text, text)', 'search_path=""', true, true),
    ('public.load_connect_onboarding_bootstrap_recovery_context(uuid, text)', 'search_path=""', true, true),
    ('public.authorize_connect_onboarding_bootstrap_account_create_v2(uuid, uuid, text, integer, text, text)', 'search_path=""', true, true),
    ('public.bind_connect_onboarding_bootstrap_account_v2(uuid, uuid, text, integer, text, text)', 'search_path=""', true, true),
    ('public.authorize_connect_onboarding_bootstrap_initial_link_v2(uuid, uuid, text, integer, text, text, text, text)', 'search_path=""', true, true),
    ('public.record_connect_onboarding_bootstrap_initial_link_response(uuid, uuid, text, integer, text, text, text, text, text, text)', 'search_path=""', true, true),
    ('public.acknowledge_connect_onboarding_bootstrap_initial_link_delivery(uuid, text, text)', 'search_path=""', true, true),
    ('private.live_billing_event_is_in_scope(text, text)', 'search_path=""', true, false),
    ('private.enforce_live_billing_checkpoint_processed_events()', 'search_path=""', true, false),
    ('private.current_connect_account_generation(jsonb)', 'search_path=""', false, true),
    ('private.bind_live_billing_authorization_checkpoint()', 'search_path=""', true, false),
    ('public.set_studio_live_billing_authorization_atomic(uuid, text, boolean, timestamp with time zone, text, uuid, text, text)', 'search_path=public, pg_temp', true, true),
    ('public.set_stripe_connect_account_exclusion_atomic(text, boolean, text, uuid, text)', 'search_path=public, pg_temp', true, true),
    ('public.finish_stripe_event_processing_v2(uuid, text, text, text, text)', 'search_path=public, pg_temp', false, true),
    ('public.prevent_operational_alert_append_only_mutation()', 'search_path=""', false, false),
    ('public.enforce_operational_alert_sent_receipt()', 'search_path=""', false, false),
    ('public.operational_alert_metric_counts()', 'search_path=public, pg_temp', false, true),
    ('public.evaluate_operational_alert(text, text, bigint, integer, integer, text, text, text, text)', 'search_path=public, pg_temp', false, false),
    ('public.evaluate_operational_alert(text, text, bigint, integer, integer, text, text, integer, text, text, text)', 'search_path=public, pg_temp', false, true),
    ('public.acknowledge_operational_alert(text, uuid, text, text)', 'search_path=public, pg_temp', false, true),
    ('public.claim_operational_alert_delivery(text, text, uuid, integer)', 'search_path=public, pg_temp', false, true),
    ('public.complete_operational_alert_delivery(uuid, text, text)', 'search_path=public, pg_temp', false, true),
    ('public.fail_operational_alert_delivery(uuid, text, text, integer)', 'search_path=public, pg_temp', false, true),
    ('public.record_operational_alert_heartbeat(text, text, text)', 'search_path=public, pg_temp', false, true),
    ('public.operational_alert_heartbeats(text)', 'search_path=public, pg_temp', false, true),
    ('public.koaryu_release_schema_preflight()', 'search_path=pg_catalog', true, true),
    ('public.koaryu_release_schema_preflight_v2()', 'search_path=pg_catalog', true, true),
    ('public.koaryu_release_schema_preflight_v3()', 'search_path=pg_catalog', true, true),
    ('public.koaryu_release_schema_preflight_v5()', 'search_path=pg_catalog', true, true),
    ('public.koaryu_release_schema_preflight_v6()', 'search_path=pg_catalog', true, false),
    ('private.koaryu_release_operational_manifest_v2()', 'search_path=pg_catalog', false, false),
    ('private.koaryu_release_operational_manifest_v2_base()', 'search_path=pg_catalog', false, false),
    ('private.koaryu_release_operational_manifest_v4()', 'search_path=pg_catalog', false, false),
    ('private.koaryu_release_operational_manifest_v5()', 'search_path=pg_catalog', false, false),
    ('private.koaryu_release_operational_manifest_v6()', 'search_path=pg_catalog', false, false),
    ('private.koaryu_release_operational_manifest_v7()', 'search_path=pg_catalog,TimeZone=UTC', false, false),
    ('private.koaryu_release_starting_belt_manifest_v9()', 'search_path=pg_catalog', false, false),
    ('private.koaryu_release_student_rank_writer_manifest_v11()', 'search_path=pg_catalog', false, false),
    ('private.koaryu_release_student_rank_writer_manifest_v13()', 'search_path=pg_catalog', false, false),
    ('private.koaryu_release_critical_surface_manifest_v15()', 'search_path=pg_catalog', false, false),
    ('private.koaryu_release_critical_surface_manifest_v16()', 'search_path=pg_catalog', false, false),
    ('private.koaryu_release_schedule_window_manifest_v1()', 'search_path=pg_catalog', false, false),
    ('public.schedule_window_read(uuid, date, date, text)', 'search_path=pg_catalog', false, true),
    ('public.write_student_profile_atomic(uuid, uuid, uuid, jsonb, uuid[], jsonb, boolean, text)', 'search_path=pg_catalog, public, private', false, true),
    ('public.write_student_profile_v2_atomic(uuid, uuid, uuid, jsonb, uuid[], jsonb, boolean, text)', 'search_path=pg_catalog, public', false, true),
    ('public.reserve_core_checkout_v2_atomic(uuid)', 'search_path=pg_catalog, public', false, true),
    ('public.set_studio_comp_v2_atomic(uuid, boolean, text, uuid, text, boolean)', 'search_path=pg_catalog, public', false, true),
    ('public.sync_belt_ladder_ranks_v2(uuid, uuid, uuid, uuid, text, jsonb)', 'search_path=pg_catalog, public', false, true),
    ('public.record_core_checkout_compensation_required_atomic(uuid, text, text, bigint, text, boolean)', 'search_path=pg_catalog, public', false, true),
    ('private.record_student_rank_transition_v2(uuid, uuid, uuid, uuid, uuid, uuid, uuid, text, text, uuid)', 'search_path=public, pg_temp', false, true),
    ('public.record_student_promotion(uuid, uuid, uuid, uuid, uuid, uuid, uuid, text)', 'search_path=pg_catalog', false, true),
    ('public.record_student_demotion(uuid, uuid, uuid, uuid, uuid, uuid, uuid, text)', 'search_path=pg_catalog', false, true),
    ('public.record_student_promotion_v2(uuid, uuid, uuid, uuid, uuid, uuid, uuid, text, uuid)', 'search_path=pg_catalog', false, true),
    ('public.record_student_demotion_v2(uuid, uuid, uuid, uuid, uuid, uuid, uuid, text, uuid)', 'search_path=pg_catalog', false, true),
    ('private.write_student_profile_atomic(uuid, uuid, uuid, jsonb, uuid[], jsonb, boolean, text)', 'search_path=public, pg_temp', false, true),
    ('public.import_student_row_atomic(jsonb, uuid, uuid, text, integer, text, text, text, text, uuid[])', 'search_path=pg_catalog, public, private', false, true),
    ('private.import_student_row_atomic(jsonb, uuid, uuid, text, integer, text, text, text, text, uuid[])', 'search_path=public, pg_temp', false, true),
    ('private.sync_connect_identity_mapping_guard()', 'search_path=pg_catalog', true, false),
    ('private.sync_connect_identity_exclusion_guard()', 'search_path=pg_catalog', true, false)
),
required_writer_results(signature, expected_result_contract) as (
  values
    ('public.write_student_profile_atomic(uuid, uuid, uuid, jsonb, uuid[], jsonb, boolean, text)', 'students'),
    ('private.write_student_profile_atomic(uuid, uuid, uuid, jsonb, uuid[], jsonb, boolean, text)', 'students'),
    ('public.import_student_row_atomic(jsonb, uuid, uuid, text, integer, text, text, text, text, uuid[])', 'TABLE(student_id uuid, guardian_imported boolean)'),
    ('private.import_student_row_atomic(jsonb, uuid, uuid, text, integer, text, text, text, text, uuid[])', 'TABLE(student_id uuid, guardian_imported boolean)')
),
function_actual as (
  select format('%I.%I(%s)', namespace.nspname, function.proname, oidvectortypes(function.proargtypes)) as signature,
         owner.rolname as owner_name, language.lanname as language_name,
         function.prosecdef as security_definer,
         coalesce(array_to_string(function.proconfig, ','), '') as search_path_config,
         replace(pg_get_function_result(function.oid), 'public.', '') as result_contract,
         exists (select 1 from aclexplode(coalesce(function.proacl, acldefault('f', function.proowner))) acl where acl.grantee = 0 and acl.privilege_type = 'EXECUTE') as public_execute,
         has_function_privilege('anon', function.oid, 'EXECUTE') as anon_execute,
         has_function_privilege('authenticated', function.oid, 'EXECUTE') as authenticated_execute,
         has_function_privilege('service_role', function.oid, 'EXECUTE') as service_execute,
         encode(extensions.digest(convert_to(function.prosrc, 'UTF8'), 'sha256'), 'hex') as body_sha256,
         coalesce((
           select string_agg(
                    coalesce(grantor.rolname, 'PUBLIC') || '>' ||
                    coalesce(grantee.rolname, 'PUBLIC') || ':' || acl.privilege_type || ':' || acl.is_grantable::text,
                    ',' order by coalesce(grantor.rolname, 'PUBLIC') collate "C", coalesce(grantee.rolname, 'PUBLIC') collate "C", acl.privilege_type collate "C", acl.is_grantable
                  )
             from aclexplode(coalesce(function.proacl, acldefault('f', function.proowner))) acl
             left join pg_roles grantor on grantor.oid = acl.grantor
             left join pg_roles grantee on grantee.oid = acl.grantee
         ), '') as acl_state,
         exists (
           select 1
             from aclexplode(coalesce(function.proacl, acldefault('f', function.proowner))) acl
             left join pg_roles grantee on grantee.oid = acl.grantee
            where acl.privilege_type = 'EXECUTE'
              and acl.grantee <> function.proowner
              and not (
                grantee.rolname = 'service_role'
                and required.service_execute
                and not acl.is_grantable
              )
         ) as unexpected_execute_grant
    from pg_proc function
    join pg_namespace namespace on namespace.oid = function.pronamespace
    join pg_roles owner on owner.oid = function.proowner
    join pg_language language on language.oid = function.prolang
    join required_functions required
      on required.signature = format('%I.%I(%s)', namespace.nspname, function.proname, oidvectortypes(function.proargtypes))
),
function_compared as (
  select required.*, actual.owner_name, actual.language_name,
         actual.security_definer as actual_security_definer,
         actual.search_path_config as actual_search_path_config,
         actual.public_execute, actual.anon_execute, actual.authenticated_execute,
         actual.service_execute as actual_service_execute,
         actual.result_contract, writer_result.expected_result_contract,
         actual.body_sha256, actual.acl_state, actual.unexpected_execute_grant
    from required_functions required
    left join function_actual actual using (signature)
    left join required_writer_results writer_result using (signature)
),
required_triggers(table_name, trigger_name, function_schema, function_name, trigger_type) as (
  values
    ('studio_subscriptions', 'preserve_studio_comp_provenance_on_metadata_update', 'public', 'preserve_studio_comp_provenance', 19),
    ('studio_live_billing_authorizations', 'set_studio_live_billing_authorizations_updated_at', 'public', 'update_updated_at_column', 19),
    ('stripe_connect_account_dispositions', 'set_stripe_connect_account_dispositions_updated_at', 'public', 'update_updated_at_column', 19),
    ('studio_live_billing_authorizations', 'bind_live_billing_authorization_checkpoint', 'private', 'bind_live_billing_authorization_checkpoint', 23),
    ('stripe_connect_onboarding_bootstraps', 'set_stripe_connect_onboarding_bootstraps_updated_at', 'public', 'update_updated_at_column', 19),
    ('stripe_live_billing_reconciliation_checkpoints', 'enforce_live_billing_checkpoint_processed_events', 'private', 'enforce_live_billing_checkpoint_processed_events', 7),
    ('operational_alert_delivery_attempts', 'prevent_operational_alert_attempt_mutation', 'public', 'prevent_operational_alert_append_only_mutation', 27),
    ('operational_alert_delivery_outcomes', 'prevent_operational_alert_outcome_mutation', 'public', 'prevent_operational_alert_append_only_mutation', 27),
    ('operational_alert_audit_events', 'prevent_operational_alert_audit_mutation', 'public', 'prevent_operational_alert_append_only_mutation', 27),
    ('operational_alert_outbox', 'enforce_operational_alert_sent_receipt', 'public', 'enforce_operational_alert_sent_receipt', 23),
    ('studio_payment_accounts', 'sync_connect_identity_mapping_guard', 'private', 'sync_connect_identity_mapping_guard', 29),
    ('stripe_connect_account_dispositions', 'sync_connect_identity_exclusion_guard', 'private', 'sync_connect_identity_exclusion_guard', 29)
),
trigger_actual as (
  select relation.relname as table_name, trigger.tgname as trigger_name,
         function_namespace.nspname as function_schema, function.proname as function_name,
         trigger.tgtype::integer as trigger_type, trigger.tgenabled, trigger.tgisinternal,
         encode(extensions.digest(convert_to(pg_get_triggerdef(trigger.oid), 'UTF8'), 'sha256'), 'hex') as definition_sha256
    from pg_trigger trigger
    join pg_class relation on relation.oid = trigger.tgrelid
    join pg_namespace namespace on namespace.oid = relation.relnamespace
    join pg_proc function on function.oid = trigger.tgfoid
    join pg_namespace function_namespace on function_namespace.oid = function.pronamespace
    join required_triggers required
      on required.table_name = relation.relname and required.trigger_name = trigger.tgname
    cross join runtime_settings
   where namespace.nspname = 'public'
),
trigger_compared as (
  select required.*, actual.function_schema as actual_function_schema,
         actual.function_name as actual_function_name,
         actual.trigger_type as actual_trigger_type,
         actual.tgenabled, actual.tgisinternal, actual.definition_sha256
    from required_triggers required
    left join trigger_actual actual using (table_name, trigger_name)
),
required_indexes(index_name, table_name, unique_index, partial_index) as (
  values
    ('idx_studio_live_billing_authorizations_enabled', 'studio_live_billing_authorizations', false, true),
    ('idx_stripe_live_billing_reconciliation_checkpoints_latest', 'stripe_live_billing_reconciliation_checkpoints', false, false),
    ('idx_stripe_events_error_reference', 'stripe_events', true, true),
    ('idx_stripe_events_live_billing_ingest_sequence', 'stripe_events', true, false),
    ('idx_stripe_connect_onboarding_bootstraps_generation_once', 'stripe_connect_onboarding_bootstraps', true, false),
    ('idx_stripe_connect_onboarding_bootstraps_delivery_receipt', 'stripe_connect_onboarding_bootstraps', true, true),
    ('operational_alert_episodes_one_unresolved', 'operational_alert_episodes', true, true),
    ('operational_alert_episodes_recent', 'operational_alert_episodes', false, false),
    ('operational_alert_outbox_claim', 'operational_alert_outbox', false, true),
    ('operational_alert_delivery_attempts_delivery', 'operational_alert_delivery_attempts', false, false),
    ('operational_alert_audit_events_episode', 'operational_alert_audit_events', false, false),
    ('promotions_studio_operation_once', 'promotions', true, true)
),
index_actual as (
  select index_relation.relname as index_name, table_relation.relname as table_name,
         index.indisunique as unique_index, index.indpred is not null as partial_index,
         index.indisvalid, index.indisready,
         encode(extensions.digest(convert_to(pg_get_indexdef(index.indexrelid), 'UTF8'), 'sha256'), 'hex') as definition_sha256
    from pg_index index
    join pg_class index_relation on index_relation.oid = index.indexrelid
    join pg_class table_relation on table_relation.oid = index.indrelid
    join pg_namespace namespace on namespace.oid = table_relation.relnamespace
    join required_indexes required on required.index_name = index_relation.relname
    cross join runtime_settings
   where namespace.nspname = 'public'
),
index_compared as (
  select required.*, actual.table_name as actual_table_name,
         actual.unique_index as actual_unique_index,
         actual.partial_index as actual_partial_index,
         actual.indisvalid, actual.indisready, actual.definition_sha256
    from required_indexes required
    left join index_actual actual using (index_name)
),
required_sequences(table_name, column_name, service_usage, service_select, service_update) as (
  values
    ('stripe_live_billing_reconciliation_checkpoints', 'checkpoint_sequence', true, true, false),
    ('stripe_events', 'live_billing_ingest_sequence', true, true, false),
    ('operational_alert_audit_events', 'id', true, true, false)
),
sequence_actual as (
  select table_relation.relname as table_name, attribute.attname as column_name,
         owner.rolname as owner_name,
         coalesce((
           select string_agg(
                    coalesce(grantor.rolname, 'PUBLIC') || '>' ||
                    coalesce(grantee.rolname, 'PUBLIC') || ':' || acl.privilege_type || ':' || acl.is_grantable::text,
                    ',' order by coalesce(grantor.rolname, 'PUBLIC') collate "C", coalesce(grantee.rolname, 'PUBLIC') collate "C", acl.privilege_type collate "C", acl.is_grantable
                  )
             from aclexplode(coalesce(sequence.relacl, acldefault('S', sequence.relowner))) acl
             left join pg_roles grantor on grantor.oid = acl.grantor
             left join pg_roles grantee on grantee.oid = acl.grantee
         ), '') as acl_state,
         exists (select 1 from aclexplode(coalesce(sequence.relacl, acldefault('S', sequence.relowner))) acl where acl.grantee = 0) as public_access,
         has_sequence_privilege('anon', sequence.oid, 'USAGE,SELECT,UPDATE') as anon_access,
         has_sequence_privilege('authenticated', sequence.oid, 'USAGE,SELECT,UPDATE') as authenticated_access,
         has_sequence_privilege('service_role', sequence.oid, 'USAGE') as service_usage,
         has_sequence_privilege('service_role', sequence.oid, 'SELECT') as service_select,
         has_sequence_privilege('service_role', sequence.oid, 'UPDATE') as service_update
    from pg_class sequence
    join pg_depend dependency on dependency.objid = sequence.oid and dependency.deptype in ('a', 'i')
    join pg_class table_relation on table_relation.oid = dependency.refobjid
    join pg_attribute attribute on attribute.attrelid = table_relation.oid and attribute.attnum = dependency.refobjsubid
    join pg_namespace namespace on namespace.oid = table_relation.relnamespace
    join pg_roles owner on owner.oid = sequence.relowner
    join required_sequences required on required.table_name = table_relation.relname and required.column_name = attribute.attname
   where namespace.nspname = 'public' and sequence.relkind = 'S'
),
sequence_compared as (
  select required.*, actual.owner_name, actual.public_access,
         actual.anon_access, actual.authenticated_access,
         actual.service_usage as actual_service_usage,
         actual.service_select as actual_service_select,
         actual.service_update as actual_service_update,
         actual.acl_state
    from required_sequences required
    left join sequence_actual actual using (table_name, column_name)
),
required_columns(table_name, column_name, data_type, nullable, identity_column) as (
  values
    ('stripe_events', 'error_reference', 'text', true, false),
    ('stripe_events', 'live_billing_ingest_sequence', 'bigint', false, true),
    ('stripe_live_billing_reconciliation_checkpoints', 'evidence_source', 'text', true, false),
    ('stripe_live_billing_reconciliation_checkpoints', 'deployment_ready_url', 'text', true, false),
    ('stripe_live_billing_reconciliation_checkpoints', 'deployment_ready_sha', 'text', true, false),
    ('stripe_live_billing_reconciliation_checkpoints', 'deployment_ready_verified_at', 'timestamp with time zone', true, false),
    ('stripe_live_billing_reconciliation_checkpoints', 'event_window_started_at', 'timestamp with time zone', true, false),
    ('stripe_live_billing_reconciliation_checkpoints', 'event_window_ended_at', 'timestamp with time zone', true, false),
    ('stripe_live_billing_reconciliation_checkpoints', 'local_event_ingest_watermark', 'bigint', true, false),
    ('stripe_live_billing_reconciliation_checkpoints', 'bounded_provider_event_count', 'integer', true, false),
    ('stripe_live_billing_reconciliation_checkpoints', 'bounded_local_event_count', 'integer', true, false),
    ('stripe_live_billing_reconciliation_checkpoints', 'provider_only_event_count', 'integer', true, false),
    ('stripe_live_billing_reconciliation_checkpoints', 'local_only_event_count', 'integer', true, false),
    ('stripe_live_billing_reconciliation_checkpoints', 'platform_provider_event_count', 'integer', true, false),
    ('stripe_live_billing_reconciliation_checkpoints', 'platform_local_event_count', 'integer', true, false),
    ('stripe_live_billing_reconciliation_checkpoints', 'platform_delivery_verified_at', 'timestamp with time zone', true, false),
    ('stripe_live_billing_reconciliation_checkpoints', 'unexpected_enabled_endpoint_count', 'integer', true, false),
    ('stripe_live_billing_reconciliation_checkpoints', 'account_evidence_count', 'integer', true, false),
    ('studio_live_billing_authorizations', 'reconciliation_checkpoint_id', 'uuid', true, false),
    ('studio_live_billing_authorizations', 'local_event_ingest_watermark', 'bigint', true, false),
    ('stripe_connect_onboarding_bootstraps', 'bootstrap_token_sha256', 'text', false, false),
    ('stripe_connect_onboarding_bootstraps', 'connect_account_generation', 'integer', false, false),
    ('stripe_connect_onboarding_bootstraps', 'initial_link_payload_sha256', 'text', true, false),
    ('stripe_connect_onboarding_bootstraps', 'stripe_connected_account_id', 'text', true, false),
    ('stripe_connect_onboarding_bootstraps', 'expires_at', 'timestamp with time zone', false, false),
    ('stripe_connect_onboarding_bootstraps', 'initial_link_claimed_at', 'timestamp with time zone', true, false),
    ('stripe_connect_onboarding_bootstraps', 'recovery_context', 'jsonb', true, false),
    ('stripe_connect_onboarding_bootstraps', 'recovery_expires_at', 'timestamp with time zone', true, false),
    ('stripe_connect_onboarding_bootstraps', 'initial_link_response_sha256', 'text', true, false),
    ('stripe_connect_onboarding_bootstraps', 'initial_link_response_recorded_at', 'timestamp with time zone', true, false),
    ('stripe_connect_onboarding_bootstraps', 'initial_link_delivery_receipt_sha256', 'text', true, false),
    ('stripe_connect_onboarding_bootstraps', 'initial_link_delivery_receipt_expires_at', 'timestamp with time zone', true, false),
    ('stripe_connect_onboarding_bootstraps', 'initial_link_delivered_at', 'timestamp with time zone', true, false),
    ('stripe_connect_onboarding_bootstraps', 'initial_link_support_required_at', 'timestamp with time zone', true, false),
    ('operational_alert_episodes', 'backup_destination_id', 'text', false, false),
    ('operational_alert_episodes', 'escalation_after_minutes', 'integer', false, false),
    ('operational_alert_episodes', 'acknowledged_at', 'timestamp with time zone', true, false),
    ('operational_alert_episodes', 'acknowledged_by_role', 'text', true, false),
    ('operational_alert_episodes', 'acknowledged_actor_ref', 'text', true, false),
    ('operational_alert_outbox', 'event_kind', 'text', false, false),
    ('operational_alert_outbox', 'destination_role', 'text', false, false),
    ('promotions', 'operation_id', 'uuid', true, false),
    ('promotions', 'transition_kind', 'text', true, false)
),
column_compared as (
  select required.*,
         actual.data_type as actual_data_type,
         actual.is_nullable = 'YES' as actual_nullable,
         actual.is_identity = 'YES' as actual_identity_column
    from required_columns required
    left join information_schema.columns actual
      on actual.table_schema = 'public'
     and actual.table_name = required.table_name
     and actual.column_name = required.column_name
),
required_constraints(table_name, constraint_identity, constraint_type) as (
  values
    ('stripe_live_billing_reconciliation_checkpoints', 'stripe_live_checkpoint_source_contract', 'c'),
    ('stripe_live_billing_reconciliation_checkpoints', 'stripe_live_checkpoint_ready_url_contract', 'c'),
    ('stripe_live_billing_reconciliation_checkpoints', 'stripe_live_checkpoint_ready_sha_contract', 'c'),
    ('stripe_live_billing_reconciliation_checkpoints', 'stripe_live_checkpoint_window_contract', 'c'),
    ('stripe_live_billing_reconciliation_checkpoints', 'stripe_live_checkpoint_watermark_contract', 'c'),
    ('stripe_live_billing_reconciliation_checkpoints', 'stripe_live_checkpoint_gap_contract', 'c'),
    ('studio_live_billing_authorizations', 'studio_live_billing_checkpoint_binding', 'c'),
    ('stripe_live_billing_reconciliation_account_evidence', 'primary:checkpoint_id,stripe_connected_account_id', 'p'),
    ('stripe_live_billing_reconciliation_account_evidence', 'unique:checkpoint_id,studio_id', 'u'),
    ('operational_alert_episodes', 'operational_alert_episode_ack_complete', 'c'),
    ('promotions', 'promotions_transition_kind_check', 'c'),
    ('operational_alert_outbox', 'operational_alert_outbox_episode_event_role_key', 'u'),
    ('operational_alert_audit_events', 'operational_alert_audit_events_event_type_check', 'c'),
    ('stripe_connect_onboarding_bootstraps', 'stripe_connect_onboarding_bootstraps_recovery_pair', 'c'),
    ('stripe_connect_onboarding_bootstraps', 'stripe_connect_onboarding_bootstraps_recovery_context_object', 'c'),
    ('stripe_connect_onboarding_bootstraps', 'stripe_connect_onboarding_bootstraps_recovery_expiry', 'c'),
    ('stripe_connect_onboarding_bootstraps', 'stripe_connect_onboarding_bootstraps_response_hash', 'c'),
    ('stripe_connect_onboarding_bootstraps', 'stripe_connect_onboarding_bootstraps_receipt_hash', 'c'),
    ('stripe_connect_onboarding_bootstraps', 'stripe_connect_onboarding_bootstraps_response_pair', 'c'),
    ('stripe_connect_onboarding_bootstraps', 'stripe_connect_onboarding_bootstraps_receipt_pair', 'c'),
    ('stripe_connect_onboarding_bootstraps', 'stripe_connect_onboarding_bootstraps_delivery_order', 'c'),
    ('stripe_connect_onboarding_bootstraps', 'stripe_connect_onboarding_bootstraps_receipt_expiry', 'c'),
    ('stripe_connect_onboarding_bootstraps', 'stripe_connect_onboarding_bootstraps_delivered_state', 'c'),
    ('stripe_connect_onboarding_bootstraps', 'stripe_connect_onboarding_bootstraps_terminal_state', 'c')
),
constraint_actual as (
  select relation.relname as table_name,
         case
           when relation.relname = 'stripe_live_billing_reconciliation_account_evidence'
            and constraint_state.contype = 'p'
             then 'primary:' || columns.column_names
           when relation.relname = 'stripe_live_billing_reconciliation_account_evidence'
            and constraint_state.contype = 'u'
             then 'unique:' || columns.column_names
           else constraint_state.conname
         end as constraint_identity,
         constraint_state.contype::text as constraint_type,
         constraint_state.convalidated,
         encode(extensions.digest(convert_to(pg_get_constraintdef(constraint_state.oid), 'UTF8'), 'sha256'), 'hex') as definition_sha256
    from pg_constraint constraint_state
    join pg_class relation on relation.oid = constraint_state.conrelid
    join pg_namespace namespace on namespace.oid = relation.relnamespace
    left join lateral (
      select string_agg(attribute.attname, ',' order by key_position.ordinality) as column_names
        from unnest(constraint_state.conkey) with ordinality key_position(attnum, ordinality)
        join pg_attribute attribute
          on attribute.attrelid = constraint_state.conrelid
         and attribute.attnum = key_position.attnum
    ) columns on true
    cross join runtime_settings
   where namespace.nspname = 'public'
),
constraint_compared as (
  select required.*,
         actual.constraint_type as actual_constraint_type,
         actual.convalidated, actual.definition_sha256
    from required_constraints required
    left join constraint_actual actual using (table_name, constraint_identity)
),
scoped_index_definitions as (
  select namespace.nspname as schema_name, table_relation.relname as table_name,
         index_relation.relname as index_name,
         encode(extensions.digest(convert_to(pg_get_indexdef(index_state.indexrelid), 'UTF8'), 'sha256'), 'hex') as definition_sha256
    from pg_index index_state
    join pg_class index_relation on index_relation.oid = index_state.indexrelid
    join pg_class table_relation on table_relation.oid = index_state.indrelid
    join pg_namespace namespace on namespace.oid = table_relation.relnamespace
    join scoped_definition_tables covered
      on covered.schema_name = namespace.nspname and covered.table_name = table_relation.relname
    cross join runtime_settings
),
scoped_constraint_definitions as (
  select namespace.nspname as schema_name, relation.relname as table_name,
         constraint_state.conname as constraint_name,
         constraint_state.contype::text as constraint_type,
         constraint_state.convalidated,
         encode(extensions.digest(convert_to(pg_get_constraintdef(constraint_state.oid), 'UTF8'), 'sha256'), 'hex') as definition_sha256
    from pg_constraint constraint_state
    join pg_class relation on relation.oid = constraint_state.conrelid
    join pg_namespace namespace on namespace.oid = relation.relnamespace
    join scoped_definition_tables covered
      on covered.schema_name = namespace.nspname and covered.table_name = relation.relname
    cross join runtime_settings
),
states as (
  select 'tables' as category, count(*)::integer as object_count,
         encode(extensions.digest(convert_to(coalesce(string_agg(schema_name || '.' || table_name || ':' || coalesce(owner_name, '') || ':' || coalesce(relrowsecurity::text, '') || ':' || coalesce(actual_service_privileges, '') || ':' || coalesce(acl_state, ''), '|' order by schema_name collate "C", table_name collate "C"), ''), 'UTF8'), 'sha256'), 'hex') as state_digest,
         count(*) filter (where owner_name is null or owner_name <> 'postgres' or relrowsecurity is distinct from rls_enabled or public_access or anon_access or authenticated_access or actual_service_privileges is distinct from service_privileges)::integer as failures
    from table_compared
  union all
  select 'table_acls', count(*)::integer,
         encode(extensions.digest(convert_to(coalesce(string_agg(schema_name || '.' || table_name || ':' || owner_name || ':' || acl_state, '|' order by schema_name collate "C", table_name collate "C"), ''), 'UTF8'), 'sha256'), 'hex'),
         0::integer
    from table_acl_definitions
  union all
  select 'column_acls', count(*)::integer,
         encode(extensions.digest(convert_to(coalesce(string_agg(schema_name || '.' || table_name || ':' || attnum::text || ':' || column_name || ':' || acl_state, '|' order by schema_name collate "C", table_name collate "C", attnum), ''), 'UTF8'), 'sha256'), 'hex'),
         0::integer
    from column_acl_definitions
  union all
  select 'policies', count(*)::integer,
         encode(extensions.digest(convert_to(coalesce(string_agg(table_name || ':' || policy_name || ':' || coalesce(actual_permissive::text, '') || ':' || coalesce(actual_command_name, '') || ':' || coalesce(actual_role_names, '') || ':' || coalesce(actual_predicate_kind, ''), '|' order by table_name collate "C", policy_name collate "C"), ''), 'UTF8'), 'sha256'), 'hex'),
         count(*) filter (where not expected_policy or not actual_policy or actual_permissive is distinct from permissive or actual_command_name is distinct from command_name or actual_role_names is distinct from role_names or actual_predicate_kind is distinct from predicate_kind)::integer
    from policy_compared
  union all
  select 'functions', count(*)::integer,
         encode(extensions.digest(convert_to(coalesce(string_agg(signature || ':' || coalesce(owner_name, '') || ':' || coalesce(language_name, '') || ':' || coalesce(actual_security_definer::text, '') || ':' || coalesce(actual_search_path_config, '') || ':' || coalesce(actual_service_execute::text, '') || ':' || coalesce(result_contract, '') || ':' || coalesce(body_sha256, '') || ':' || coalesce(acl_state, ''), '|' order by signature collate "C"), ''), 'UTF8'), 'sha256'), 'hex'),
         count(*) filter (where owner_name is null or owner_name <> 'postgres' or language_name not in ('sql', 'plpgsql') or actual_security_definer is distinct from security_definer or actual_search_path_config is distinct from search_path_config or public_execute or anon_execute or authenticated_execute or actual_service_execute is distinct from service_execute or unexpected_execute_grant or (expected_result_contract is not null and result_contract is distinct from expected_result_contract))::integer
    from function_compared
  union all
  select 'triggers', count(*)::integer,
         encode(extensions.digest(convert_to(coalesce(string_agg(table_name || ':' || trigger_name || ':' || coalesce(actual_function_schema, '') || '.' || coalesce(actual_function_name, '') || ':' || coalesce(actual_trigger_type::text, '') || ':' || coalesce(tgenabled::text, '') || ':' || coalesce(definition_sha256, ''), '|' order by table_name collate "C", trigger_name collate "C"), ''), 'UTF8'), 'sha256'), 'hex'),
         count(*) filter (where actual_function_schema is distinct from function_schema or actual_function_name is distinct from function_name or actual_trigger_type is distinct from trigger_type or tgenabled is distinct from 'O' or tgisinternal is distinct from false)::integer
    from trigger_compared
  union all
  select 'indexes', count(*)::integer,
         encode(extensions.digest(convert_to(coalesce(string_agg(index_name || ':' || coalesce(actual_table_name, '') || ':' || coalesce(actual_unique_index::text, '') || ':' || coalesce(actual_partial_index::text, '') || ':' || coalesce(indisvalid::text, '') || ':' || coalesce(indisready::text, '') || ':' || coalesce(definition_sha256, ''), '|' order by index_name collate "C"), ''), 'UTF8'), 'sha256'), 'hex'),
         count(*) filter (where actual_table_name is distinct from table_name or actual_unique_index is distinct from unique_index or actual_partial_index is distinct from partial_index or indisvalid is distinct from true or indisready is distinct from true)::integer
    from index_compared
  union all
  select 'sequences', count(*)::integer,
         encode(extensions.digest(convert_to(coalesce(string_agg(table_name || '.' || column_name || ':' || coalesce(owner_name, '') || ':' || coalesce(actual_service_usage::text, '') || ':' || coalesce(actual_service_select::text, '') || ':' || coalesce(actual_service_update::text, '') || ':' || coalesce(acl_state, ''), '|' order by table_name collate "C", column_name collate "C"), ''), 'UTF8'), 'sha256'), 'hex'),
         count(*) filter (where owner_name is null or owner_name <> 'postgres' or public_access or anon_access or authenticated_access or actual_service_usage is distinct from service_usage or actual_service_select is distinct from service_select or actual_service_update is distinct from service_update)::integer
    from sequence_compared
  union all
  select 'columns', count(*)::integer,
         encode(extensions.digest(convert_to(coalesce(string_agg(table_name || '.' || column_name || ':' || coalesce(actual_data_type, '') || ':' || coalesce(actual_nullable::text, '') || ':' || coalesce(actual_identity_column::text, ''), '|' order by table_name collate "C", column_name collate "C"), ''), 'UTF8'), 'sha256'), 'hex'),
         count(*) filter (where actual_data_type is distinct from data_type or actual_nullable is distinct from nullable or actual_identity_column is distinct from identity_column)::integer
    from column_compared
  union all
  select 'constraints', count(*)::integer,
         encode(extensions.digest(convert_to(coalesce(string_agg(table_name || ':' || constraint_identity || ':' || coalesce(actual_constraint_type, '') || ':' || coalesce(convalidated::text, '') || ':' || coalesce(definition_sha256, ''), '|' order by table_name collate "C", constraint_identity collate "C"), ''), 'UTF8'), 'sha256'), 'hex'),
         count(*) filter (where actual_constraint_type is distinct from constraint_type or convalidated is distinct from true)::integer
    from constraint_compared
  union all
  select 'scoped_indexes', count(*)::integer,
         encode(extensions.digest(convert_to(coalesce(string_agg(schema_name || '.' || table_name || ':' || index_name || ':' || definition_sha256, '|' order by schema_name collate "C", table_name collate "C", index_name collate "C"), ''), 'UTF8'), 'sha256'), 'hex'),
         0::integer
    from scoped_index_definitions
  union all
  select 'scoped_constraints', count(*)::integer,
         encode(extensions.digest(convert_to(coalesce(string_agg(schema_name || '.' || table_name || ':' || constraint_name || ':' || constraint_type || ':' || convalidated::text || ':' || definition_sha256, '|' order by schema_name collate "C", table_name collate "C", constraint_name collate "C"), ''), 'UTF8'), 'sha256'), 'hex'),
         count(*) filter (where not convalidated)::integer
    from scoped_constraint_definitions
)
select string_agg(category || '=' || object_count::text || ':' || state_digest || ':' || failures::text, ';' order by category collate "C") as catalog_state
from states
`;

export function assertSafeCredentialedTransport(env) {
  const trustOverrideNames = new Set([
    "CURL_CA_BUNDLE",
    "NODE_EXTRA_CA_CERTS",
    "NODE_TLS_REJECT_UNAUTHORIZED",
    "PGSSLMODE",
    "PGSSLROOTCERT",
    "REQUESTS_CA_BUNDLE",
    "SSL_CERT_DIR",
    "SSL_CERT_FILE",
  ]);
  const overrideNames = Object.keys(env).filter(
    (name) =>
      /^(?:https?|all|ftp)_proxy$/i.test(name) ||
      name === "GIT_PROXY_COMMAND" ||
      trustOverrideNames.has(name),
  );
  const active = overrideNames.filter(
    (name) => typeof env[name] === "string" && env[name].length > 0,
  );
  if (active.length > 0) {
    throw new RolloutError(
      `Refusing credentialed work while ambient proxy or TLS trust override variables are present: ${active.sort().join(", ")}.`,
    );
  }
}

export function parseArguments(argv) {
  const result = {
    mode: "inspect",
    target: null,
    candidateSha: null,
    confirmProject: null,
    approvalRecord: null,
    inspectionToken: null,
    expectedProviderFingerprint: null,
    confirmedRestoreWindow: null,
    restoreDecisionAuthority: null,
    approveStagingApply: false,
    humanProductionOperator: false,
  };
  const valueOptions = new Map([
    ["--mode", "mode"],
    ["--target", "target"],
    ["--candidate-sha", "candidateSha"],
    ["--confirm-project", "confirmProject"],
    ["--approval-record", "approvalRecord"],
    ["--inspection-token", "inspectionToken"],
    ["--expected-provider-fingerprint", "expectedProviderFingerprint"],
    ["--confirmed-restore-window", "confirmedRestoreWindow"],
    ["--restore-decision-authority", "restoreDecisionAuthority"],
  ]);
  const booleanOptions = new Map([
    ["--approve-staging-apply", "approveStagingApply"],
    ["--human-production-operator", "humanProductionOperator"],
  ]);
  const seen = new Set();

  for (let index = 0; index < argv.length; index += 1) {
    const option = argv[index];
    if (seen.has(option)) {
      throw new RolloutError(`Duplicate option: ${option}`);
    }
    seen.add(option);
    if (valueOptions.has(option)) {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new RolloutError(`${option} requires a value.`);
      }
      result[valueOptions.get(option)] = assertPlainText(option, value);
      index += 1;
      continue;
    }
    if (booleanOptions.has(option)) {
      result[booleanOptions.get(option)] = true;
      continue;
    }
    throw new RolloutError(`Unknown option: ${option}`);
  }

  if (!new Set(["packet", "inspect", "diagnose", "dry-run", "apply"]).has(result.mode)) {
    throw new RolloutError("--mode must be packet, inspect, diagnose, dry-run, or apply.");
  }
  if (result.mode !== "packet" && !new Set(["staging", "production"]).has(result.target)) {
    throw new RolloutError("--target must be staging or production.");
  }
  if (result.mode === "packet" && result.target !== null) {
    throw new RolloutError("--mode packet is local-only and must not specify --target.");
  }
  if (!/^[0-9a-f]{40}$/.test(result.candidateSha ?? "")) {
    throw new RolloutError("--candidate-sha must be a full lowercase 40-character commit SHA.");
  }
  if (
    result.expectedProviderFingerprint !== null &&
    !/^functions=3:[0-9a-f]{32}:0;trigger=1:[0-9a-f]{32}:0;catalog=[a-z0-9_=;:]+;critical_surface=0:[0-9a-f]{64}$/.test(
      result.expectedProviderFingerprint,
    )
  ) {
    throw new RolloutError("--expected-provider-fingerprint has an invalid shape.");
  }
  if (result.inspectionToken !== null && !/^[0-9a-f]{64}$/.test(result.inspectionToken)) {
    throw new RolloutError("--inspection-token has an invalid shape.");
  }
  if (new Set(["packet", "inspect"]).has(result.mode) && result.inspectionToken !== null) {
    throw new RolloutError("--inspection-token is created by inspect and cannot be supplied to inspect.");
  }
  if (result.mode === "diagnose" && result.inspectionToken !== null) {
    throw new RolloutError("--inspection-token cannot be supplied with --mode diagnose.");
  }
  if (new Set(["dry-run", "apply"]).has(result.mode) && result.inspectionToken === null) {
    throw new RolloutError("Target inspection evidence is required through --inspection-token.");
  }
  if (result.mode !== "apply") {
    const applyOnly = [
      result.confirmProject,
      result.approvalRecord,
      result.confirmedRestoreWindow,
      result.restoreDecisionAuthority,
      result.approveStagingApply,
      result.humanProductionOperator,
    ];
    if (applyOnly.some(Boolean)) {
      throw new RolloutError("Apply authorization options are valid only with --mode apply.");
    }
  }
  if (
    new Set(["packet", "diagnose", "dry-run"]).has(result.mode) &&
    result.expectedProviderFingerprint
  ) {
    throw new RolloutError(
      "--expected-provider-fingerprint is valid only for inspection comparison or production apply.",
    );
  }
  return result;
}

export function validateApplyAuthorization(config) {
  if (config.mode !== "apply") return;
  const projectRef = config.target === "staging" ? ROLLOUT.stagingRef : ROLLOUT.productionRef;
  if (config.confirmProject !== projectRef) {
    throw new RolloutError(`--confirm-project must exactly equal the pinned ${config.target} ref.`);
  }
  assertPlainText("--approval-record", config.approvalRecord);
  if (!/^https:\/\/github\.com\/ronchak\/Koaryu\/pull\/138#issuecomment-[1-9][0-9]*$/.test(config.approvalRecord)) {
    throw new RolloutError(
      "--approval-record must be an exact PR #138 GitHub issue-comment URL.",
    );
  }
  if (config.target === "staging") {
    if (
      !config.approveStagingApply ||
      config.humanProductionOperator ||
      config.expectedProviderFingerprint ||
      config.confirmedRestoreWindow ||
      config.restoreDecisionAuthority
    ) {
      throw new RolloutError(
        "Staging apply requires --approve-staging-apply and must not use production-only authorization fields.",
      );
    }
    return;
  }
  if (!config.humanProductionOperator) {
    throw new RolloutError("Production apply requires --human-production-operator.");
  }
  if (!config.expectedProviderFingerprint) {
    throw new RolloutError(
      "Production apply requires the approved staging --expected-provider-fingerprint.",
    );
  }
  assertPlainText("--confirmed-restore-window", config.confirmedRestoreWindow);
  assertPlainText("--restore-decision-authority", config.restoreDecisionAuthority);
}

export function buildApplyApprovalRecordBody(packet, target, state) {
  const projectRef = target === "staging" ? ROLLOUT.stagingRef : ROLLOUT.productionRef;
  return [
    "Koaryu guarded database apply approval v1",
    "approval=approved",
    `target=${target}`,
    `project_ref=${projectRef}`,
    `candidate_sha=${packet.candidateSha}`,
    `inspection_state=${state}`,
    `remaining_migration_count=${packet.pendingMigrations.length}`,
    `remaining_manifest_sha256=${packet.sourceManifestSha256}`,
    `remaining_migrations=${packet.pendingMigrations.join(",")}`,
  ].join("\n");
}

export function validateApplyApprovalRecord(
  config,
  packet,
  state,
  commandRunner = runCommand,
  env = process.env,
) {
  if (config.mode !== "apply") return;
  const match = config.approvalRecord.match(
    /^https:\/\/github\.com\/ronchak\/Koaryu\/pull\/138#issuecomment-([1-9][0-9]*)$/,
  );
  if (!match) {
    throw new RolloutError(
      "--approval-record must be an exact PR #138 GitHub issue-comment URL.",
    );
  }
  const rawComment = commandRunner(
    "gh",
    ["api", `repos/ronchak/Koaryu/issues/comments/${match[1]}`],
    { env, label: "durable apply approval read" },
  );
  let comment;
  try {
    comment = JSON.parse(rawComment);
  } catch {
    throw new RolloutError(
      "Durable approval record lookup did not return structured GitHub comment data.",
    );
  }
  if (
    !comment ||
    Array.isArray(comment) ||
    typeof comment !== "object" ||
    typeof comment.body !== "string" ||
    typeof comment.issue_url !== "string" ||
    !comment.user ||
    Array.isArray(comment.user) ||
    typeof comment.user !== "object" ||
    typeof comment.user.login !== "string" ||
    typeof comment.author_association !== "string"
  ) {
    throw new RolloutError(
      "Durable approval record lookup did not return structured GitHub comment data.",
    );
  }
  if (comment.issue_url !== "https://api.github.com/repos/ronchak/Koaryu/issues/138") {
    throw new RolloutError(
      "Durable approval record does not belong to ronchak/Koaryu PR #138.",
    );
  }
  if (
    comment.user.login !== APPLY_APPROVAL_AUTHOR_LOGIN ||
    comment.author_association !== APPLY_APPROVAL_AUTHOR_ASSOCIATION
  ) {
    throw new RolloutError(
      "Durable approval record was not authored by the authorized Koaryu repository owner.",
    );
  }
  const expected = buildApplyApprovalRecordBody(packet, config.target, state);
  if (comment.body !== expected) {
    throw new RolloutError(
      "Durable approval record does not exactly bind this candidate, target, inspected state, and remaining migration manifest.",
    );
  }
}

export function buildInspectionToken(packet, target, state) {
  return digest(
    "sha256",
    [packet.candidateSha, packet.postHistory, packet.sourceManifestSha256, target, state].join("|"),
  );
}

export function formatNonSuccessProbeState(result) {
  if (
    result?.state === "pre" ||
    result?.state === "intermediate" ||
    result?.state === "recovery" ||
    result?.state === "convergence" ||
    result?.state === "attested" ||
    result?.state === "return-attested" ||
    result?.state === "retained" ||
    result?.state === "critical" ||
    result?.state === "column-attested" ||
    result?.state === "trial-locked" ||
    result?.state === "staff-identity" ||
    result?.state === "restored-v22" ||
    result?.state === "canonical-v23" ||
    result?.state === "restored-v23-pending-v24" ||
    result?.state === "v24" ||
    result?.state === "schedule-v25" ||
    result?.state === "v25" ||
    result?.state === "v26" ||
    result?.state === "v27" ||
    result?.state === "v28" ||
    result?.state === "v29" ||
    result?.state === "v30" ||
    result?.state === "v31" ||
    result?.state === "v32" ||
    result?.state === "v33" ||
    result?.state === "v34" ||
    result?.state === "v35" ||
    result?.state === "post"
  ) return null;
  if (
    result?.state === "unknown" &&
    (result.reason === "timeout" || result.reason === "connectivity")
  ) {
    return `state=UNKNOWN(${result.reason})`;
  }
  if (result?.state === "diverged" && typeof result.detail === "string" && result.detail.length > 0) {
    return `state=DIVERGED(${result.detail})`;
  }
  throw new RolloutError("Remote probe returned an unsupported non-success result.");
}

export function buildInspectionTokenForAcceptedState(packet, target, result) {
  if (
    result?.state !== "pre" &&
    result?.state !== "intermediate" &&
    result?.state !== "recovery" &&
    result?.state !== "convergence" &&
    result?.state !== "attested" &&
    result?.state !== "return-attested" &&
    result?.state !== "retained" &&
    result?.state !== "critical" &&
    result?.state !== "column-attested" &&
    result?.state !== "trial-locked" &&
    result?.state !== "staff-identity" &&
    result?.state !== "restored-v22" &&
    result?.state !== "canonical-v23" &&
    result?.state !== "restored-v23-pending-v24" &&
    result?.state !== "v24" &&
    result?.state !== "schedule-v25" &&
    result?.state !== "v25" &&
    result?.state !== "v26" &&
    result?.state !== "v27" &&
    result?.state !== "v28" &&
    result?.state !== "v29" &&
    result?.state !== "v30" &&
    result?.state !== "v31" &&
    result?.state !== "v32" &&
    result?.state !== "v33" &&
    result?.state !== "v34" &&
    result?.state !== "v35" &&
    result?.state !== "post"
  ) {
    throw new RolloutError("Inspection tokens require an accepted pre, intermediate, recovery, convergence, attested, return-attested, retained, critical, column-attested, trial-locked, staff-identity, restored-v22, canonical-v23, restored-v23-pending-v24, v24, schedule-v25, v25, v26, v27, v28, v29, v30, v31, v32, v33, v34, v35, or post probe state.");
  }
  return buildInspectionToken(packet, target, result.state);
}

export function assertInspectionToken(packet, target, result, inspectionToken) {
  const expected = buildInspectionTokenForAcceptedState(packet, target, result);
  if (inspectionToken !== expected) {
    throw new RolloutError(
      "--inspection-token does not match the preceding inspection's candidate, target, and state.",
    );
  }
}

export function verifySourceTree(sourceRoot, candidateSha, commandRunner = runCommand) {
  const actualSha = commandRunner("git", ["-C", sourceRoot, "rev-parse", "HEAD"], {
    label: "candidate SHA read",
  }).trim();
  if (actualSha !== candidateSha) {
    throw new RolloutError(
      `Candidate SHA mismatch: expected ${candidateSha}, found ${actualSha}.`,
    );
  }

  for (const requiredSha of ROLLOUT.requiredAncestry) {
    commandRunner("git", ["-C", sourceRoot, "merge-base", "--is-ancestor", requiredSha, candidateSha], {
      label: `required ancestry check for ${requiredSha}`,
    });
  }

  const migrationsDirectory = path.join(sourceRoot, "supabase", "migrations");
  const filenames = fs
    .readdirSync(migrationsDirectory)
    .filter((name) => name.endsWith(".sql"))
    .sort();
  if (filenames.length !== ROLLOUT.finalMigrationCount) {
    throw new RolloutError(
      `Candidate must contain exactly ${ROLLOUT.finalMigrationCount} migrations, found ${filenames.length}.`,
    );
  }
  for (const filename of filenames) {
    if (!/^[0-9]{14}_[A-Za-z0-9_]+\.sql$/.test(filename)) {
      throw new RolloutError(`Invalid migration filename in candidate: ${filename}`);
    }
  }

  const orderedHistory = filenames
    .map((filename) => {
      const separator = filename.indexOf("_");
      return `${filename.slice(0, separator)}:${filename.slice(separator + 1, -4)}`;
    })
    .join("|");
  const preHistory = `${ROLLOUT.baselineMigrationCount}:${digest(
    "md5",
    filenames.slice(0, ROLLOUT.baselineMigrationCount)
    .map((filename) => {
      const separator = filename.indexOf("_");
      return `${filename.slice(0, separator)}:${filename.slice(separator + 1, -4)}`;
    })
    .join("|"),
  )}`;
  const postHistory = `${filenames.length}:${digest("md5", orderedHistory)}`;
  const intermediateHistory = `${ROLLOUT.intermediateMigrationCount}:${digest(
    "md5",
    filenames.slice(0, ROLLOUT.intermediateMigrationCount)
      .map((filename) => {
        const separator = filename.indexOf("_");
        return `${filename.slice(0, separator)}:${filename.slice(separator + 1, -4)}`;
      })
      .join("|"),
  )}`;
  const recoveryHistory = `${ROLLOUT.recoveryMigrationCount}:${digest(
    "md5",
    filenames.slice(0, ROLLOUT.recoveryMigrationCount)
      .map((filename) => {
        const separator = filename.indexOf("_");
        return `${filename.slice(0, separator)}:${filename.slice(separator + 1, -4)}`;
      })
      .join("|"),
  )}`;
  const convergenceHistory = `${ROLLOUT.convergenceMigrationCount}:${digest(
    "md5",
    filenames.slice(0, ROLLOUT.convergenceMigrationCount)
      .map((filename) => {
        const separator = filename.indexOf("_");
        return `${filename.slice(0, separator)}:${filename.slice(separator + 1, -4)}`;
      })
      .join("|"),
  )}`;
  const attestedHistory = `${ROLLOUT.attestedMigrationCount}:${digest(
    "md5",
    filenames.slice(0, ROLLOUT.attestedMigrationCount)
      .map((filename) => {
        const separator = filename.indexOf("_");
        return `${filename.slice(0, separator)}:${filename.slice(separator + 1, -4)}`;
      })
      .join("|"),
  )}`;
  const returnAttestedHistory = `${ROLLOUT.returnAttestedMigrationCount}:${digest(
    "md5",
    filenames.slice(0, ROLLOUT.returnAttestedMigrationCount)
      .map((filename) => {
        const separator = filename.indexOf("_");
        return `${filename.slice(0, separator)}:${filename.slice(separator + 1, -4)}`;
      })
      .join("|"),
  )}`;
  const retainedHistory = `${ROLLOUT.retainedMigrationCount}:${digest(
    "md5",
    filenames.slice(0, ROLLOUT.retainedMigrationCount)
      .map((filename) => {
        const separator = filename.indexOf("_");
        return `${filename.slice(0, separator)}:${filename.slice(separator + 1, -4)}`;
      })
      .join("|"),
  )}`;
  const criticalHistory = `${ROLLOUT.criticalMigrationCount}:${digest(
    "md5",
    filenames.slice(0, ROLLOUT.criticalMigrationCount)
      .map((filename) => {
        const separator = filename.indexOf("_");
        return `${filename.slice(0, separator)}:${filename.slice(separator + 1, -4)}`;
      })
      .join("|"),
  )}`;
  const columnAttestedHistory = `${ROLLOUT.columnAttestedMigrationCount}:${digest(
    "md5",
    filenames.slice(0, ROLLOUT.columnAttestedMigrationCount)
      .map((filename) => {
        const separator = filename.indexOf("_");
        return `${filename.slice(0, separator)}:${filename.slice(separator + 1, -4)}`;
      })
      .join("|"),
  )}`;
  const trialLockedHistory = `${ROLLOUT.trialLockedMigrationCount}:${digest(
    "md5",
    filenames.slice(0, ROLLOUT.trialLockedMigrationCount)
      .map((filename) => {
        const separator = filename.indexOf("_");
        return `${filename.slice(0, separator)}:${filename.slice(separator + 1, -4)}`;
      })
      .join("|"),
  )}`;
  const staffIdentityHistory = `${ROLLOUT.staffIdentityMigrationCount}:${digest(
    "md5",
    filenames.slice(0, ROLLOUT.staffIdentityMigrationCount)
      .map((filename) => {
        const separator = filename.indexOf("_");
        return `${filename.slice(0, separator)}:${filename.slice(separator + 1, -4)}`;
      })
      .join("|"),
  )}`;
  const restoredV22History = `${ROLLOUT.restoredV22MigrationCount}:${digest(
    "md5",
    filenames.slice(0, ROLLOUT.restoredV22MigrationCount)
      .map((filename) => {
        const separator = filename.indexOf("_");
        return `${filename.slice(0, separator)}:${filename.slice(separator + 1, -4)}`;
      })
      .join("|"),
  )}`;
  const canonicalV23History = `${ROLLOUT.canonicalV23MigrationCount}:${digest(
    "md5",
    filenames.slice(0, ROLLOUT.canonicalV23MigrationCount)
      .map((filename) => {
        const separator = filename.indexOf("_");
        return `${filename.slice(0, separator)}:${filename.slice(separator + 1, -4)}`;
      })
      .join("|"),
  )}`;
  const v24History = `${ROLLOUT.v24MigrationCount}:${digest(
    "md5",
    filenames.slice(0, ROLLOUT.v24MigrationCount)
      .map((filename) => {
        const separator = filename.indexOf("_");
        return `${filename.slice(0, separator)}:${filename.slice(separator + 1, -4)}`;
      })
      .join("|"),
  )}`;
  const scheduleV25History = `${ROLLOUT.scheduleV25MigrationCount}:${digest(
    "md5",
    filenames.slice(0, ROLLOUT.scheduleV25MigrationCount)
      .map((filename) => {
        const separator = filename.indexOf("_");
        return `${filename.slice(0, separator)}:${filename.slice(separator + 1, -4)}`;
      })
      .join("|"),
  )}`;
  const v25History = `${ROLLOUT.v25MigrationCount}:${digest(
    "md5",
    filenames.slice(0, ROLLOUT.v25MigrationCount)
      .map((filename) => {
        const separator = filename.indexOf("_");
        return `${filename.slice(0, separator)}:${filename.slice(separator + 1, -4)}`;
      })
      .join("|"),
  )}`;
  const v26History = `${ROLLOUT.v26MigrationCount}:${digest(
    "md5",
    filenames.slice(0, ROLLOUT.v26MigrationCount)
      .map((filename) => {
        const separator = filename.indexOf("_");
        return `${filename.slice(0, separator)}:${filename.slice(separator + 1, -4)}`;
      })
      .join("|"),
  )}`;
  const v27History = `${ROLLOUT.v27MigrationCount}:${digest(
    "md5",
    filenames.slice(0, ROLLOUT.v27MigrationCount)
      .map((filename) => {
        const separator = filename.indexOf("_");
        return `${filename.slice(0, separator)}:${filename.slice(separator + 1, -4)}`;
      })
      .join("|"),
  )}`;
  const v28History = `${ROLLOUT.v28MigrationCount}:${digest(
    "md5",
    filenames.slice(0, ROLLOUT.v28MigrationCount)
      .map((filename) => {
        const separator = filename.indexOf("_");
        return `${filename.slice(0, separator)}:${filename.slice(separator + 1, -4)}`;
      })
      .join("|"),
  )}`;
  const v29History = `${ROLLOUT.v29MigrationCount}:${digest(
    "md5",
    filenames.slice(0, ROLLOUT.v29MigrationCount)
      .map((filename) => {
        const separator = filename.indexOf("_");
        return `${filename.slice(0, separator)}:${filename.slice(separator + 1, -4)}`;
      })
      .join("|"),
  )}`;
  const v30History = `${ROLLOUT.v30MigrationCount}:${digest(
    "md5",
    filenames.slice(0, ROLLOUT.v30MigrationCount)
      .map((filename) => {
        const separator = filename.indexOf("_");
        return `${filename.slice(0, separator)}:${filename.slice(separator + 1, -4)}`;
      })
      .join("|"),
  )}`;
  const historyAt = (count) => `${count}:${digest("md5", filenames.slice(0,count)
    .map((filename) => {
      const separator=filename.indexOf("_");
      return `${filename.slice(0,separator)}:${filename.slice(separator+1,-4)}`;
    }).join("|"))}`;
  const v31History=historyAt(ROLLOUT.v31MigrationCount);
  const v32History=historyAt(ROLLOUT.v32MigrationCount);
  const v33History=historyAt(ROLLOUT.v33MigrationCount);
  const v34History=historyAt(ROLLOUT.v34MigrationCount);
  const v35History=historyAt(ROLLOUT.v35MigrationCount);
  if (preHistory !== ROLLOUT.preHistory) {
    throw new RolloutError(
      `Candidate's first ${ROLLOUT.baselineMigrationCount} migration names do not match the production baseline.`,
    );
  }
  const expectedTail = ROLLOUT.migrations.map(({ filename }) => filename);
  if (JSON.stringify(filenames.slice(84, 86)) !== JSON.stringify(expectedTail)) {
    throw new RolloutError("The July studio-comp pair must be the first two migrations after baseline 84.");
  }
  const expectedScheduleMigrations = ROLLOUT.scheduleMigrations.map(
    ({ filename }) => filename,
  );
  if (
    JSON.stringify(
      filenames.slice(ROLLOUT.v24MigrationCount, ROLLOUT.scheduleV25MigrationCount),
    ) !== JSON.stringify(expectedScheduleMigrations)
  ) {
    throw new RolloutError(
      "The reviewed PR #133 schedule pair must immediately follow the V24 migration.",
    );
  }

  for (const migration of [...ROLLOUT.migrations, ...ROLLOUT.scheduleMigrations]) {
    const actualHash = hashFile(path.join(migrationsDirectory, migration.filename));
    if (actualHash !== migration.sha256) {
      throw new RolloutError(`Source hash mismatch for ${migration.filename}.`);
    }
  }

  const pendingMigrations = filenames.slice(ROLLOUT.baselineMigrationCount);
  const pendingVersions = pendingMigrations.map((filename) => filename.slice(0, 14));
  const pendingManifest = pendingMigrations.map((filename) => ({
    filename,
    sha256: hashFile(path.join(migrationsDirectory, filename)),
  }));
  return {
    candidateSha,
    migrationCount: filenames.length,
    postHistory,
    intermediateHistory,
    recoveryHistory,
    convergenceHistory,
    attestedHistory,
    returnAttestedHistory,
    retainedHistory,
    criticalHistory,
    columnAttestedHistory,
    trialLockedHistory,
    staffIdentityHistory,
    restoredV22History,
    canonicalV23History,
    v24History,
    scheduleV25History,
    v25History,
    v26History,
    v27History,
    v28History,
    v29History,
    v30History,
    v31History,
    v32History,
    v33History,
    v34History,
    v35History,
    preTargetHistory: filenames.slice(84, ROLLOUT.baselineMigrationCount)
      .map((filename) => {
        const separator = filename.indexOf("_");
        return `${filename.slice(0, separator)}:${filename.slice(separator + 1, -4)}`;
      })
      .join("|"),
    postTargetHistory: filenames.slice(84)
      .map((filename) => {
        const separator = filename.indexOf("_");
        return `${filename.slice(0, separator)}:${filename.slice(separator + 1, -4)}`;
      })
      .join("|"),
    intermediateTargetHistory: filenames.slice(84, ROLLOUT.intermediateMigrationCount)
      .map((filename) => {
        const separator = filename.indexOf("_");
        return `${filename.slice(0, separator)}:${filename.slice(separator + 1, -4)}`;
      })
      .join("|"),
    recoveryTargetHistory: filenames.slice(84, ROLLOUT.recoveryMigrationCount)
      .map((filename) => {
        const separator = filename.indexOf("_");
        return `${filename.slice(0, separator)}:${filename.slice(separator + 1, -4)}`;
      })
      .join("|"),
    convergenceTargetHistory: filenames.slice(84, ROLLOUT.convergenceMigrationCount)
      .map((filename) => {
        const separator = filename.indexOf("_");
        return `${filename.slice(0, separator)}:${filename.slice(separator + 1, -4)}`;
      })
      .join("|"),
    attestedTargetHistory: filenames.slice(84, ROLLOUT.attestedMigrationCount)
      .map((filename) => {
        const separator = filename.indexOf("_");
        return `${filename.slice(0, separator)}:${filename.slice(separator + 1, -4)}`;
      })
      .join("|"),
    returnAttestedTargetHistory: filenames.slice(84, ROLLOUT.returnAttestedMigrationCount)
      .map((filename) => {
        const separator = filename.indexOf("_");
        return `${filename.slice(0, separator)}:${filename.slice(separator + 1, -4)}`;
      })
      .join("|"),
    retainedTargetHistory: filenames.slice(84, ROLLOUT.retainedMigrationCount)
      .map((filename) => {
        const separator = filename.indexOf("_");
        return `${filename.slice(0, separator)}:${filename.slice(separator + 1, -4)}`;
      })
      .join("|"),
    criticalTargetHistory: filenames.slice(84, ROLLOUT.criticalMigrationCount)
      .map((filename) => {
        const separator = filename.indexOf("_");
        return `${filename.slice(0, separator)}:${filename.slice(separator + 1, -4)}`;
      })
      .join("|"),
    columnAttestedTargetHistory: filenames.slice(84, ROLLOUT.columnAttestedMigrationCount)
      .map((filename) => {
        const separator = filename.indexOf("_");
        return `${filename.slice(0, separator)}:${filename.slice(separator + 1, -4)}`;
      })
      .join("|"),
    trialLockedTargetHistory: filenames.slice(84, ROLLOUT.trialLockedMigrationCount)
      .map((filename) => {
        const separator = filename.indexOf("_");
        return `${filename.slice(0, separator)}:${filename.slice(separator + 1, -4)}`;
      })
      .join("|"),
    staffIdentityTargetHistory: filenames.slice(84, ROLLOUT.staffIdentityMigrationCount)
      .map((filename) => {
        const separator = filename.indexOf("_");
        return `${filename.slice(0, separator)}:${filename.slice(separator + 1, -4)}`;
      })
      .join("|"),
    restoredV22TargetHistory: filenames.slice(84, ROLLOUT.restoredV22MigrationCount)
      .map((filename) => {
        const separator = filename.indexOf("_");
        return `${filename.slice(0, separator)}:${filename.slice(separator + 1, -4)}`;
      })
      .join("|"),
    canonicalV23TargetHistory: filenames.slice(84, ROLLOUT.canonicalV23MigrationCount)
      .map((filename) => {
        const separator = filename.indexOf("_");
        return `${filename.slice(0, separator)}:${filename.slice(separator + 1, -4)}`;
      })
      .join("|"),
    v24TargetHistory: filenames.slice(84, ROLLOUT.v24MigrationCount)
      .map((filename) => {
        const separator = filename.indexOf("_");
        return `${filename.slice(0, separator)}:${filename.slice(separator + 1, -4)}`;
      })
      .join("|"),
    scheduleV25TargetHistory: filenames.slice(84, ROLLOUT.scheduleV25MigrationCount)
      .map((filename) => {
        const separator = filename.indexOf("_");
        return `${filename.slice(0, separator)}:${filename.slice(separator + 1, -4)}`;
      })
      .join("|"),
    v25TargetHistory: filenames.slice(84, ROLLOUT.v25MigrationCount)
      .map((filename) => {
        const separator = filename.indexOf("_");
        return `${filename.slice(0, separator)}:${filename.slice(separator + 1, -4)}`;
      })
      .join("|"),
    v26TargetHistory: filenames.slice(84, ROLLOUT.v26MigrationCount)
      .map((filename) => {
        const separator = filename.indexOf("_");
        return `${filename.slice(0, separator)}:${filename.slice(separator + 1, -4)}`;
      })
      .join("|"),
    v27TargetHistory: filenames.slice(84, ROLLOUT.v27MigrationCount)
      .map((filename) => {
        const separator = filename.indexOf("_");
        return `${filename.slice(0, separator)}:${filename.slice(separator + 1, -4)}`;
      })
      .join("|"),
    v28TargetHistory: filenames.slice(84, ROLLOUT.v28MigrationCount)
      .map((filename) => {
        const separator = filename.indexOf("_");
        return `${filename.slice(0, separator)}:${filename.slice(separator + 1, -4)}`;
      })
      .join("|"),
    v29TargetHistory: filenames.slice(84, ROLLOUT.v29MigrationCount)
      .map((filename) => {
        const separator = filename.indexOf("_");
        return `${filename.slice(0, separator)}:${filename.slice(separator + 1, -4)}`;
      })
      .join("|"),
    v30TargetHistory: filenames.slice(84, ROLLOUT.v30MigrationCount)
      .map((filename) => {
        const separator = filename.indexOf("_");
        return `${filename.slice(0, separator)}:${filename.slice(separator + 1, -4)}`;
      })
      .join("|"),
    v31TargetHistory: filenames.slice(84,ROLLOUT.v31MigrationCount)
      .map((filename)=>{const separator=filename.indexOf("_");
        return `${filename.slice(0,separator)}:${filename.slice(separator+1,-4)}`;}).join("|"),
    v32TargetHistory: filenames.slice(84,ROLLOUT.v32MigrationCount)
      .map((filename)=>{const separator=filename.indexOf("_");
        return `${filename.slice(0,separator)}:${filename.slice(separator+1,-4)}`;}).join("|"),
    v33TargetHistory: filenames.slice(84,ROLLOUT.v33MigrationCount)
      .map((filename)=>{const separator=filename.indexOf("_");
        return `${filename.slice(0,separator)}:${filename.slice(separator+1,-4)}`;}).join("|"),
    v34TargetHistory: filenames.slice(84,ROLLOUT.v34MigrationCount)
      .map((filename)=>{const separator=filename.indexOf("_");
        return `${filename.slice(0,separator)}:${filename.slice(separator+1,-4)}`;}).join("|"),
    v35TargetHistory: filenames.slice(84,ROLLOUT.v35MigrationCount)
      .map((filename)=>{const separator=filename.indexOf("_");
        return `${filename.slice(0,separator)}:${filename.slice(separator+1,-4)}`;}).join("|"),
    pendingMigrations,
    integrationComplete:
      filenames.length === ROLLOUT.finalMigrationCount &&
      JSON.stringify(pendingVersions) === JSON.stringify(ROLLOUT.releasePendingVersions),
    sourceManifestSha256: digest(
      "sha256",
      pendingManifest.map(({ filename, sha256 }) => `${filename}:${sha256}`).join("|"),
    ),
    pendingManifest,
  };
}

export function packetForAcceptedState(packet, state) {
  if (state === "pre") return packet;
  const consumedMigrations =
    state === "intermediate"
      ? 1
      : state === "recovery"
        ? 2
        : state === "convergence"
          ? 3
          : state === "attested"
            ? 4
            : state === "return-attested"
              ? 5
              : state === "retained"
                ? 6
                : state === "critical"
                  ? 7
                  : state === "column-attested"
                    ? 8
                    : state === "trial-locked"
                      ? ROLLOUT.trialLockedMigrationCount - ROLLOUT.baselineMigrationCount
                    : state === "staff-identity"
                      ? ROLLOUT.staffIdentityMigrationCount - ROLLOUT.baselineMigrationCount
                      : state === "restored-v22"
                        ? ROLLOUT.restoredV22MigrationCount - ROLLOUT.baselineMigrationCount
                        : state === "canonical-v23"
                          ? ROLLOUT.canonicalV23MigrationCount - ROLLOUT.baselineMigrationCount
                        : state === "restored-v23-pending-v24"
                          ? ROLLOUT.canonicalV23MigrationCount - ROLLOUT.baselineMigrationCount
                        : state === "v24"
                          ? ROLLOUT.v24MigrationCount - ROLLOUT.baselineMigrationCount
                        : state === "schedule-v25"
                          ? ROLLOUT.scheduleV25MigrationCount - ROLLOUT.baselineMigrationCount
                        : state === "v25"
                          ? ROLLOUT.v25MigrationCount - ROLLOUT.baselineMigrationCount
                        : state === "v26"
                          ? ROLLOUT.v26MigrationCount - ROLLOUT.baselineMigrationCount
                        : state === "v27"
                          ? ROLLOUT.v27MigrationCount - ROLLOUT.baselineMigrationCount
                        : state === "v28"
                          ? ROLLOUT.v28MigrationCount - ROLLOUT.baselineMigrationCount
                        : state === "v29"
                          ? ROLLOUT.v29MigrationCount - ROLLOUT.baselineMigrationCount
                        : state === "v30"
                          ? ROLLOUT.v30MigrationCount - ROLLOUT.baselineMigrationCount
                        : state === "v31"
                          ? ROLLOUT.v31MigrationCount - ROLLOUT.baselineMigrationCount
                        : state === "v32"
                          ? ROLLOUT.v32MigrationCount - ROLLOUT.baselineMigrationCount
                        : state === "v33"
                          ? ROLLOUT.v33MigrationCount - ROLLOUT.baselineMigrationCount
                        : state === "v34"
                          ? ROLLOUT.v34MigrationCount - ROLLOUT.baselineMigrationCount
                        : state === "v35"
                          ? ROLLOUT.v35MigrationCount - ROLLOUT.baselineMigrationCount
                          : null;
  if (consumedMigrations === null) {
    throw new RolloutError("A migration packet can only be selected from pre, intermediate, recovery, convergence, attested, return-attested, retained, critical, column-attested, trial-locked, staff-identity, restored-v22, canonical-v23, restored-v23-pending-v24, v24, schedule-v25, v25, v26, v27, v28, v29, v30, v31, v32, v33, v34, or v35 state.");
  }
  const pendingMigrations = packet.pendingMigrations.slice(consumedMigrations);
  const pendingManifest = packet.pendingManifest.slice(consumedMigrations);
  return {
    ...packet,
    pendingMigrations,
    pendingManifest,
    sourceManifestSha256: digest(
      "sha256",
      pendingManifest.map(({ filename, sha256 }) => `${filename}:${sha256}`).join("|"),
    ),
  };
}

export function assertApplyableState(mode, state) {
  if (mode === "apply" && (
    state === "intermediate" || state === "recovery" || state === "convergence"
  )) {
    throw new RolloutError(
      `Apply is disabled from ${state} state because its historical readiness version does not attest every object needed for a safe forward recovery. Inspect the provider catalogs and repair to an attested state before applying.`,
    );
  }
}

export function classifyStateSnapshot(snapshot, packet, expectedProviderFingerprint = null) {
  const {
    history,
    targetHistory,
    objectCounts,
    functionState,
    triggerState,
    catalogState,
    scheduleWindowManifest,
    criticalSurfaceManifest,
    v26ExpectationState,
    v27ExpectationState,
    v28ExpectationState,
    v29ExpectationState,
    v29TransitionManifest,
    v29OperationalContract,
    v29OperationalManifest,
    v30ExpectationState,
    v30ReplayRepairsManifest,
    v30OperationalContract,
    v30OperationalManifest,
    v31ExpectationState,
    v31ResourceOwnershipManifest,
    v31OperationalContract,
    v31OperationalManifest,
    v35EvidenceManifest,
    v36RecoveryManifest,
    operationalReadiness,
    writerReturnContractState,
  } = snapshot;
  const historySchema = validateHistoryColumnMetadata(snapshot.historyColumns);
  if (!historySchema.accepted) {
    throw new RolloutError(
      `Supabase migration history schema rejected: ${historySchema.reason}.`,
    );
  }
  if (history === ROLLOUT.preHistory) {
    if (targetHistory !== packet.preTargetHistory || objectCounts !== "3:1") {
      throw new RolloutError(
        "Migration history is pre-state but the exact V7 target history or studio-comp objects are missing.",
      );
    }
    if (operationalReadiness !== EXPECTED_PRE_OPERATIONAL_READINESS) {
      throw new RolloutError("V7 operational readiness did not match the exact production baseline.");
    }
    return { state: "pre", providerFingerprint: null };
  }
  if (history === packet.intermediateHistory) {
    if (
      targetHistory !== packet.intermediateTargetHistory ||
      objectCounts !== "3:1"
    ) {
      throw new RolloutError(
        "Migration history is intermediate but the exact V8 target history or studio-comp objects are missing.",
      );
    }
    if (operationalReadiness !== EXPECTED_INTERMEDIATE_OPERATIONAL_READINESS) {
      throw new RolloutError("V8 operational readiness did not match the exact intermediate state.");
    }
    return { state: "intermediate", providerFingerprint: null };
  }
  if (history === packet.recoveryHistory) {
    if (targetHistory !== packet.recoveryTargetHistory || objectCounts !== "3:1") {
      throw new RolloutError(
        "Migration history is recovery-state but the exact V9 target history or studio-comp objects are missing.",
      );
    }
    if (operationalReadiness !== EXPECTED_RECOVERY_OPERATIONAL_READINESS[0]) {
      throw new RolloutError("V9 operational readiness did not match the exact recovery state.");
    }
    return { state: "recovery", providerFingerprint: null };
  }
  if (history === packet.convergenceHistory) {
    if (targetHistory !== packet.convergenceTargetHistory || objectCounts !== "3:1") {
      throw new RolloutError(
        "Migration history is convergence-state but the exact V10 target history or studio-comp objects are missing.",
      );
    }
    if (operationalReadiness !== EXPECTED_CONVERGENCE_OPERATIONAL_READINESS) {
      throw new RolloutError("V10 operational readiness did not match the exact convergence state.");
    }
    return { state: "convergence", providerFingerprint: null };
  }
  if (history === packet.attestedHistory) {
    if (targetHistory !== packet.attestedTargetHistory || objectCounts !== "3:1") {
      throw new RolloutError(
        "Migration history is attested-state but the exact V11 target history or studio-comp objects are missing.",
      );
    }
    if (operationalReadiness !== EXPECTED_ATTESTED_OPERATIONAL_READINESS) {
      throw new RolloutError("V11 operational readiness did not match the exact attested state.");
    }
    if (writerReturnContractState !== EXPECTED_WRITER_RETURN_CONTRACT_STATE) {
      throw new RolloutError("V11 writer return contracts do not match the repository-pinned pre-V13 proof.");
    }
    return { state: "attested", providerFingerprint: null };
  }
  if (history === packet.returnAttestedHistory) {
    if (targetHistory !== packet.returnAttestedTargetHistory || objectCounts !== "3:1") {
      throw new RolloutError("Migration history is return-attested but its exact V12 target history is missing.");
    }
    if (operationalReadiness !== EXPECTED_RETURN_ATTESTED_OPERATIONAL_READINESS) {
      throw new RolloutError("V12 operational readiness did not match the exact migration-105 state.");
    }
    if (writerReturnContractState !== EXPECTED_WRITER_RETURN_CONTRACT_STATE) {
      throw new RolloutError("V12 writer return contracts do not match the repository-pinned proof.");
    }
    return { state: "return-attested", providerFingerprint: null };
  }
  if (history === packet.retainedHistory) {
    if (targetHistory !== packet.retainedTargetHistory || objectCounts !== "3:1") {
      throw new RolloutError("Migration history is retained but its exact V13 target history is missing.");
    }
    if (operationalReadiness !== EXPECTED_RETAINED_OPERATIONAL_READINESS) {
      throw new RolloutError("V13 operational readiness did not match the exact migration-106 state.");
    }
    if (writerReturnContractState !== EXPECTED_WRITER_RETURN_CONTRACT_STATE) {
      throw new RolloutError("V13 writer return contracts do not match the repository-pinned proof.");
    }
    return { state: "retained", providerFingerprint: null };
  }
  if (history === packet.criticalHistory) {
    if (targetHistory !== packet.criticalTargetHistory || objectCounts !== "3:1") {
      throw new RolloutError("Migration history is critical but its exact V14 target history is missing.");
    }
    if (operationalReadiness !== EXPECTED_CRITICAL_OPERATIONAL_READINESS) {
      throw new RolloutError("V14 operational readiness did not match the exact migration-107 state.");
    }
    if (writerReturnContractState !== EXPECTED_WRITER_RETURN_CONTRACT_STATE) {
      throw new RolloutError("V14 writer return contracts do not match the repository-pinned proof.");
    }
    return { state: "critical", providerFingerprint: null };
  }
  if (history === packet.columnAttestedHistory) {
    if (targetHistory !== packet.columnAttestedTargetHistory || objectCounts !== "3:1") {
      throw new RolloutError("Migration history is column-attested but its exact V15 target history is missing.");
    }
    if (operationalReadiness !== EXPECTED_COLUMN_ATTESTED_OPERATIONAL_READINESS) {
      throw new RolloutError("V15 operational readiness did not match the exact migration-108 state.");
    }
    if (writerReturnContractState !== EXPECTED_WRITER_RETURN_CONTRACT_STATE) {
      throw new RolloutError("V15 writer return contracts do not match the repository-pinned proof.");
    }
    return { state: "column-attested", providerFingerprint: null };
  }
  if (history === packet.trialLockedHistory) {
    if (targetHistory !== packet.trialLockedTargetHistory || objectCounts !== "3:1") {
      throw new RolloutError("Migration history is trial-locked but its exact V16 target history is missing.");
    }
    if (operationalReadiness !== EXPECTED_TRIAL_LOCKED_OPERATIONAL_READINESS) {
      throw new RolloutError("V16 operational readiness did not match the exact migration-109 state.");
    }
    return { state: "trial-locked", providerFingerprint: null };
  }
  if (history === packet.staffIdentityHistory) {
    if (targetHistory !== packet.staffIdentityTargetHistory || objectCounts !== "3:1") {
      throw new RolloutError("Migration history is staff-identity but its exact V17 target history is missing.");
    }
    if (operationalReadiness !== EXPECTED_STAFF_IDENTITY_OPERATIONAL_READINESS) {
      throw new RolloutError("V17 operational readiness did not match the exact migration-110 state.");
    }
    return { state: "staff-identity", providerFingerprint: null };
  }
  if (history === packet.restoredV22History) {
    if (targetHistory !== packet.restoredV22TargetHistory || objectCounts !== "3:1") {
      throw new RolloutError("Migration history is restored-v22 but its exact V22 target history is missing.");
    }
    if (operationalReadiness !== EXPECTED_RESTORED_V22_OPERATIONAL_READINESS) {
      throw new RolloutError("Restored V22 operational readiness did not match the exact proved production state.");
    }
    return { state: "restored-v22", providerFingerprint: null };
  }
  if (history === packet.canonicalV23History) {
    if (targetHistory !== packet.canonicalV23TargetHistory || objectCounts !== "3:1") {
      throw new RolloutError("Migration history is canonical-v23 but its exact V23 target history is missing.");
    }
    if (operationalReadiness === EXPECTED_CANONICAL_V23_OPERATIONAL_READINESS) {
      return { state: "canonical-v23", providerFingerprint: null };
    }
    if (operationalReadiness === EXPECTED_RESTORED_V23_PENDING_V24_OPERATIONAL_READINESS) {
      return { state: "restored-v23-pending-v24", providerFingerprint: null };
    }
    throw new RolloutError("V23 operational readiness did not match exact canonical staging or restored-production forward-recovery state.");
  }
  if (history === packet.v24History) {
    if (targetHistory !== packet.v24TargetHistory || objectCounts !== "3:1") {
      throw new RolloutError("Migration history is V24 but its exact target history is missing.");
    }
    if (operationalReadiness !== EXPECTED_V24_OPERATIONAL_READINESS) {
      throw new RolloutError("V24 operational readiness did not match the exact proved predecessor state.");
    }
    return { state: "v24", providerFingerprint: null };
  }
  if (history === packet.scheduleV25History) {
    if (
      targetHistory !== packet.scheduleV25TargetHistory ||
      objectCounts !== "3:1"
    ) {
      throw new RolloutError(
        "Migration history is schedule V25 but its exact target history is missing.",
      );
    }
    if (operationalReadiness !== EXPECTED_SCHEDULE_V25_OPERATIONAL_READINESS) {
      throw new RolloutError(
        "Schedule V25 operational readiness did not match the exact PR #133 release state.",
      );
    }
    if (scheduleWindowManifest !== EXPECTED_SCHEDULE_WINDOW_MANIFEST) {
      throw new RolloutError(
        "Schedule V25 window manifest did not match the exact PR #133 release state.",
      );
    }
    if (catalogState !== EXPECTED_SCHEDULE_V25_CATALOG_STATE) {
      throw new RolloutError(
        "Schedule V25 raw catalog did not match the exact canonical PR #133 state.",
      );
    }
    return { state: "schedule-v25", providerFingerprint: null };
  }
  if (history === packet.v25History) {
    if (targetHistory !== packet.v25TargetHistory || objectCounts !== "3:1") {
      throw new RolloutError("Migration history is V25 but its exact target history is missing.");
    }
    if (operationalReadiness !== EXPECTED_V25_OPERATIONAL_READINESS) {
      throw new RolloutError("V25 operational readiness did not match the exact proved predecessor state.");
    }
    return { state: "v25", providerFingerprint: null };
  }
  if (history === packet.v26History) {
    if (targetHistory !== packet.v26TargetHistory || objectCounts !== "3:1") {
      throw new RolloutError("Migration history is V26 but its exact target history is missing.");
    }
    if (operationalReadiness !== EXPECTED_V26_OPERATIONAL_READINESS) {
      throw new RolloutError("V26 operational readiness did not match the exact proved predecessor state.");
    }
    return { state: "v26", providerFingerprint: null };
  }
  if (history === packet.v27History) {
    if (targetHistory !== packet.v27TargetHistory || objectCounts !== "3:1") {
      throw new RolloutError("Migration history is V27 but its exact target history is missing.");
    }
    if (operationalReadiness !== EXPECTED_V27_OPERATIONAL_READINESS) {
      throw new RolloutError("V27 operational readiness did not match the exact proved predecessor state.");
    }
    return { state: "v27", providerFingerprint: null };
  }
  if (history === packet.v28History) {
    if (targetHistory !== packet.v28TargetHistory || objectCounts !== "3:1") {
      throw new RolloutError("Migration history is V28 but its exact target history is missing.");
    }
    if (operationalReadiness !== EXPECTED_V28_OPERATIONAL_READINESS) {
      throw new RolloutError("V28 operational readiness did not match the exact proved predecessor state.");
    }
    return { state: "v28", providerFingerprint: null };
  }
  if (history === packet.v29History) {
    if (targetHistory !== packet.v29TargetHistory || objectCounts !== "3:1") {
      throw new RolloutError("Migration history is V29 but its exact target history is missing.");
    }
    if (operationalReadiness !== EXPECTED_V29_OPERATIONAL_READINESS) {
      throw new RolloutError("V29 operational readiness did not match the exact proved predecessor state.");
    }
    return { state: "v29", providerFingerprint: null };
  }
  if (history === packet.v30History) {
    if (targetHistory !== packet.v30TargetHistory || objectCounts !== "3:1") {
      throw new RolloutError("Migration history is V30 but its exact target history is missing.");
    }
    validateV30OperationalReadiness(operationalReadiness);
    return { state: "v30", providerFingerprint: null };
  }
  if (history===packet.v31History) {
    if(targetHistory!==packet.v31TargetHistory||objectCounts!=="3:1")
      throw new RolloutError("Migration history is V31 but its exact target history is missing.");
    if(operationalReadiness!==EXPECTED_V31_OPERATIONAL_READINESS)
      throw new RolloutError("V31 operational readiness did not match the exact predecessor state.");
    if(catalogState!==EXPECTED_V31_CATALOG_STATE&&catalogState!==EXPECTED_V31_RESTORED_CATALOG_STATE)
      throw new RolloutError("V31 raw catalog did not match an exact canonical or restored state.");
    return {state:"v31",providerFingerprint:null};
  }
  if (history===packet.v32History) {
    if(targetHistory!==packet.v32TargetHistory||objectCounts!=="3:1")
      throw new RolloutError("Migration history is V32 but its exact target history is missing.");
    if(operationalReadiness!==EXPECTED_V32_OPERATIONAL_READINESS)
      throw new RolloutError("V32 operational readiness did not match the exact predecessor state.");
    if(catalogState!==EXPECTED_V32_CATALOG_STATE&&catalogState!==EXPECTED_V32_RESTORED_CATALOG_STATE)
      throw new RolloutError("V32 raw catalog did not match an exact canonical or restored predecessor state.");
    return {state:"v32",providerFingerprint:null};
  }
  if (history===packet.v33History) {
    if(targetHistory!==packet.v33TargetHistory||objectCounts!=="3:1")
      throw new RolloutError("Migration history is V33 but its exact target history is missing.");
    if(operationalReadiness!==EXPECTED_V33_OPERATIONAL_READINESS)
      throw new RolloutError("V33 operational readiness did not match the exact predecessor state.");
    if(catalogState!==EXPECTED_V33_CATALOG_STATE&&catalogState!==EXPECTED_V33_RESTORED_CATALOG_STATE)
      throw new RolloutError("V33 raw catalog did not match an exact canonical or restored state.");
    return {state:"v33",providerFingerprint:null};
  }
  if (history===packet.v34History) {
    if(targetHistory!==packet.v34TargetHistory||objectCounts!=="3:1")
      throw new RolloutError("Migration history is V34 but its exact target history is missing.");
    if(operationalReadiness!==EXPECTED_V34_OPERATIONAL_READINESS)
      throw new RolloutError("V34 operational readiness did not match the exact predecessor state.");
    if(catalogState!==EXPECTED_V34_CATALOG_STATE&&catalogState!==EXPECTED_V34_RESTORED_CATALOG_STATE)
      throw new RolloutError("V34 raw catalog did not match an exact canonical or restored state.");
    return {state:"v34",providerFingerprint:null};
  }
  if (history===packet.v35History) {
    if(targetHistory!==packet.v35TargetHistory||objectCounts!=="3:1")
      throw new RolloutError("Migration history is V35 but its exact target history is missing.");
    if(operationalReadiness!==EXPECTED_V35_OPERATIONAL_READINESS)
      throw new RolloutError("V35 operational readiness did not match the exact predecessor state.");
    if(catalogState!==EXPECTED_V35_CATALOG_STATE&&catalogState!==EXPECTED_V35_RESTORED_CATALOG_STATE)
      throw new RolloutError("V35 raw catalog did not match an exact canonical or restored state.");
    return {state:"v35",providerFingerprint:null};
  }
  if (history === packet.postHistory) {
    if (!packet.integrationComplete) {
      throw new RolloutError(
        `Candidate does not contain the exact final ${ROLLOUT.finalMigrationCount}-migration sequence; post-state cannot be certified.`,
      );
    }
    if (targetHistory !== packet.postTargetHistory || objectCounts !== "3:1") {
      throw new RolloutError("Post-state history does not have the exact expected studio-comp objects.");
    }
    if (!/^3:[0-9a-f]{32}:0$/.test(functionState ?? "")) {
      throw new RolloutError("Function owner, definition, security, search path, or ACL checks failed.");
    }
    if (!/^1:[0-9a-f]{32}:0$/.test(triggerState ?? "")) {
      throw new RolloutError("Trigger definition, binding, enabled state, or metadata column check failed.");
    }
    validateCatalogState(catalogState);
    validateV30CompatV26ExpectationState(v26ExpectationState);
    if(v27ExpectationState!==EXPECTED_V36_COMPAT_V27_EXPECTATION_STATE||
       v28ExpectationState!==EXPECTED_V36_COMPAT_V28_EXPECTATION_STATE||
       v29ExpectationState!==EXPECTED_V36_COMPAT_V29_EXPECTATION_STATE)
      throw new RolloutError("V36 predecessor expectation states mismatch.");
    if(v29TransitionManifest!==EXPECTED_V34_COMPAT_V29_TRANSITION_MANIFEST||
       v29OperationalContract!==EXPECTED_V36_COMPAT_V29_OPERATIONAL_CONTRACT||
       v29OperationalManifest!==EXPECTED_V36_COMPAT_V29_OPERATIONAL_MANIFEST)
      throw new RolloutError("V34 compatibility V29 manifests mismatch.");
    if(v30ExpectationState!==EXPECTED_V36_COMPAT_V30_EXPECTATION_STATE)
      throw new RolloutError("V36 compatibility V30 expectation mismatch.");
    if(v30ReplayRepairsManifest!==EXPECTED_V34_COMPAT_V30_REPLAY_REPAIRS_MANIFEST||
       v30OperationalContract!==EXPECTED_V36_COMPAT_V30_OPERATIONAL_CONTRACT||
       v30OperationalManifest!==EXPECTED_V36_OPERATIONAL_MANIFEST_V11||
       v31ExpectationState!==EXPECTED_V36_EXPECTATION_STATE||
       v31ResourceOwnershipManifest!==EXPECTED_V36_RESOURCE_OWNERSHIP_MANIFEST||
       v31OperationalContract!==EXPECTED_V36_OPERATIONAL_CONTRACT_V31||
       v31OperationalManifest!==EXPECTED_V36_OPERATIONAL_MANIFEST_V12)
      throw new RolloutError("V34 final operational manifests mismatch.");
    if(v35EvidenceManifest!==EXPECTED_V35_EVIDENCE_MANIFEST)
      throw new RolloutError("V35 evidence manifest mismatch.");
    if(v36RecoveryManifest!==EXPECTED_V36_RECOVERY_MANIFEST)
      throw new RolloutError("V36 recovery manifest mismatch.");
    validateCriticalSurfaceManifest(criticalSurfaceManifest);
    validateOperationalReadiness(operationalReadiness);
    const providerFingerprint =
      `functions=${functionState};trigger=${triggerState};catalog=${catalogState};expectation=${v26ExpectationState};v27_expectation=${v27ExpectationState};v28_expectation=${v28ExpectationState};v29_expectation=${v29ExpectationState};v29_transition=${v29TransitionManifest};v29_contract=${v29OperationalContract};v29_manifest=${v29OperationalManifest};v30_expectation=${v30ExpectationState};v30_replay=${v30ReplayRepairsManifest};v30_contract=${v30OperationalContract};v30_manifest=${v30OperationalManifest};v31_compat_v30_manifest=${v30OperationalManifest};v31_expectation=${v31ExpectationState};v31_resource=${v31ResourceOwnershipManifest};v31_contract=${v31OperationalContract};v31_manifest=${v31OperationalManifest};v35_evidence=${v35EvidenceManifest};v36_recovery=${v36RecoveryManifest};critical_surface=${criticalSurfaceManifest}`;
    if (
      expectedProviderFingerprint &&
      !approvedProviderFingerprintVariants(expectedProviderFingerprint).includes(
        providerFingerprint,
      )
    ) {
      throw new RolloutError("Provider fingerprint does not match an exact approved staging or restored-production catalog state.");
    }
    return { state: "post", providerFingerprint };
  }
  throw new RolloutError(
    `Unexpected migration history ${history}; expected exact pre-, intermediate-, recovery-, convergence-, attested-, return-attested-, retained-, critical-, column-attested-, trial-locked-, staff-identity-, restored-v22-, canonical-v23-, restored-v23-pending-v24-, v24-, schedule-v25, v25, v26, v27, v28, v29, v30, v31, v32, v33, v34, v35, or post-state.`,
  );
}

export function validateCatalogState(catalogState) {
  if (
    catalogState !== EXPECTED_CATALOG_STATE &&
    catalogState !== EXPECTED_RESTORED_CATALOG_STATE &&
    catalogState !== EXPECTED_COMBINED_RESTORED_V26_CATALOG_STATE &&
    catalogState !== EXPECTED_V29_RESTORED_CATALOG_STATE &&
    catalogState !== EXPECTED_V30_CATALOG_STATE &&
    catalogState !== EXPECTED_V30_RESTORED_CATALOG_STATE &&
    catalogState !== EXPECTED_V31_CATALOG_STATE &&
    catalogState !== EXPECTED_V31_RESTORED_CATALOG_STATE &&
    catalogState !== EXPECTED_V32_CATALOG_STATE &&
    catalogState !== EXPECTED_V32_RESTORED_CATALOG_STATE &&
    catalogState !== EXPECTED_V34_CATALOG_STATE &&
    catalogState !== EXPECTED_V34_RESTORED_CATALOG_STATE &&
    catalogState !== EXPECTED_V35_CATALOG_STATE &&
    catalogState !== EXPECTED_V35_RESTORED_CATALOG_STATE &&
    catalogState !== EXPECTED_V36_CATALOG_STATE &&
    catalogState !== EXPECTED_V36_RESTORED_CATALOG_STATE
  ) {
    throw new RolloutError(
      `Repository-pinned raw catalog manifest mismatch: ${catalogState}.`,
    );
  }
  return catalogState;
}

export function validateV27CatalogState(catalogState) {
  if (
    catalogState !== EXPECTED_CATALOG_STATE &&
    catalogState !== EXPECTED_COMBINED_RESTORED_V26_CATALOG_STATE &&
    catalogState !== EXPECTED_V27_RESTORED_CATALOG_STATE
  ) {
    throw new RolloutError(`V27 raw catalog manifest mismatch: ${catalogState}.`);
  }
  return catalogState;
}

export function approvedProviderFingerprintVariants(stagingFingerprint) {
  if (typeof stagingFingerprint !== "string") {
    throw new RolloutError("Approved staging provider fingerprint is missing or malformed.");
  }
  const prefixPattern = /^functions=3:[0-9a-f]{32}:0;trigger=1:[0-9a-f]{32}:0;catalog=/;
  const canonicalCatalog = `catalog=${EXPECTED_V36_CATALOG_STATE}`;
  const expectedSuffix =
    `;expectation=${EXPECTED_V30_COMPAT_V26_EXPECTATION_STATE};v27_expectation=${EXPECTED_V36_COMPAT_V27_EXPECTATION_STATE};` +
    `v28_expectation=${EXPECTED_V36_COMPAT_V28_EXPECTATION_STATE};v29_expectation=${EXPECTED_V36_COMPAT_V29_EXPECTATION_STATE};` +
    `v29_transition=${EXPECTED_V34_COMPAT_V29_TRANSITION_MANIFEST};v29_contract=${EXPECTED_V36_COMPAT_V29_OPERATIONAL_CONTRACT};` +
    `v29_manifest=${EXPECTED_V36_COMPAT_V29_OPERATIONAL_MANIFEST};` +
    `v30_expectation=${EXPECTED_V36_COMPAT_V30_EXPECTATION_STATE};v30_replay=${EXPECTED_V34_COMPAT_V30_REPLAY_REPAIRS_MANIFEST};` +
    `v30_contract=${EXPECTED_V36_COMPAT_V30_OPERATIONAL_CONTRACT};v30_manifest=${EXPECTED_V36_OPERATIONAL_MANIFEST_V11};` +
    `v31_compat_v30_manifest=${EXPECTED_V36_OPERATIONAL_MANIFEST_V11};` +
    `v31_expectation=${EXPECTED_V36_EXPECTATION_STATE};v31_resource=${EXPECTED_V36_RESOURCE_OWNERSHIP_MANIFEST};` +
    `v31_contract=${EXPECTED_V36_OPERATIONAL_CONTRACT_V31};v31_manifest=${EXPECTED_V36_OPERATIONAL_MANIFEST_V12};` +
    `v35_evidence=${EXPECTED_V35_EVIDENCE_MANIFEST};v36_recovery=${EXPECTED_V36_RECOVERY_MANIFEST};` +
    `critical_surface=${EXPECTED_CRITICAL_SURFACE_MANIFEST}`;
  if (
    !prefixPattern.test(stagingFingerprint) ||
    !stagingFingerprint.endsWith(expectedSuffix) ||
    !stagingFingerprint.includes(canonicalCatalog)
  ) {
    throw new RolloutError(
      "Approved provider fingerprint is not the exact canonical staging evidence shape.",
    );
  }
  return [
    stagingFingerprint,
    stagingFingerprint.replace(
      canonicalCatalog,
      `catalog=${EXPECTED_V36_RESTORED_CATALOG_STATE}`,
    ),
  ];
}

export function extractPendingMigrations(output) {
  return [...output.matchAll(/\b(20[0-9]{12}_[A-Za-z0-9_]+\.sql)\b/g)].map(
    (match) => match[1],
  );
}

export function assertExactPendingMigrations(output, packet) {
  const expected = packet.pendingMigrations;
  const actual = extractPendingMigrations(output);
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new RolloutError(
      `Dry-run migration set mismatch: expected ${expected.join(", ")}; found ${actual.join(", ") || "none"}.`,
    );
  }
  return actual;
}

export function runCommand(
  command,
  args,
  {
    cwd = REPOSITORY_ROOT,
    env = process.env,
    label = command,
    timeout = DEFAULT_COMMAND_TIMEOUT_MS,
    capture = "stdout",
  } = {},
) {
  if (!Number.isSafeInteger(timeout) || timeout <= 0) {
    throw new RolloutError("runCommand timeout must be a positive integer.");
  }
  if (!new Set(["stdout", "stderr"]).has(capture)) {
    throw new RolloutError("runCommand capture must be stdout or stderr.");
  }
  const result = spawnSync(command, args, {
    cwd,
    env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout,
  });
  if (result.error?.code === "ETIMEDOUT") {
    throw new RolloutError(`${label} failed: UNKNOWN(timeout) after ${timeout} ms.`);
  }
  if (result.error || result.status !== 0) {
    throw new RolloutError(`${label} failed (exit ${result.status ?? "unavailable"}).`);
  }
  return result[capture];
}

export function parseSingleValueCsv(output, expectedHeader) {
  const malformed = (reason) => {
    throw new RolloutError(`${expectedHeader} query returned ${reason}.`);
  };
  if (typeof output !== "string") {
    malformed("an unexpected CSV shape");
  }
  if (/[\x00-\x09\x0b\x0c\x0e-\x1f\x7f]/.test(output)) {
    malformed("noncanonical control characters");
  }

  const records = [];
  let record = [];
  let field = "";
  let state = "start";
  let justEndedRecord = false;

  const endField = () => {
    record.push(field);
    field = "";
    state = "start";
  };
  const endRecord = () => {
    endField();
    records.push(record);
    record = [];
    justEndedRecord = true;
  };

  for (let index = 0; index < output.length;) {
    const character = output[index];
    justEndedRecord = false;

    if (state === "quoted") {
      if (character === '"') {
        if (output[index + 1] === '"') {
          field += '"';
          index += 2;
        } else {
          state = "after_quote";
          index += 1;
        }
      } else if (character === "\r") {
        if (output[index + 1] !== "\n") {
          malformed("a malformed CSV record ending");
        }
        field += "\r\n";
        index += 2;
      } else {
        field += character;
        index += 1;
      }
      continue;
    }

    if (state === "after_quote") {
      if (character === ",") {
        endField();
        index += 1;
      } else if (character === "\n") {
        endRecord();
        index += 1;
      } else if (character === "\r" && output[index + 1] === "\n") {
        endRecord();
        index += 2;
      } else {
        malformed("malformed CSV quoting");
      }
      continue;
    }

    if (character === '"') {
      if (state !== "start") {
        malformed("malformed CSV quoting");
      }
      state = "quoted";
      index += 1;
    } else if (character === ",") {
      endField();
      index += 1;
    } else if (character === "\n") {
      endRecord();
      index += 1;
    } else if (character === "\r") {
      if (output[index + 1] !== "\n") {
        malformed("a malformed CSV record ending");
      }
      endRecord();
      index += 2;
    } else {
      field += character;
      state = "unquoted";
      index += 1;
    }
  }

  if (state === "quoted") {
    malformed("malformed CSV quoting");
  }
  if (!justEndedRecord) {
    endRecord();
  }
  if (
    records.length !== 2 ||
    records[0].length !== 1 ||
    records[0][0] !== expectedHeader ||
    records[1].length !== 1
  ) {
    malformed("an unexpected CSV shape");
  }
  return records[1][0];
}

function querySingleValue(sourceRoot, sql, header, env) {
  const output = runCommand(
    "supabase",
    ["db", "query", "--linked", "--agent=no", "--output", "csv", sql],
    { cwd: sourceRoot, env, label: `${header} read` },
  );
  return parseSingleValueCsv(output, header);
}

export function readRemoteState(
  sourceRoot,
  packet,
  env,
  expectedProviderFingerprint = null,
  query = querySingleValue,
) {
  let snapshot;
  try {
    snapshot = {
      historyColumns: query(sourceRoot, HISTORY_COLUMNS_SQL, "history_columns", env),
      history: query(sourceRoot, HISTORY_SQL, "history_state", env),
      targetHistory: query(sourceRoot, TARGET_HISTORY_SQL, "target_history", env),
      objectCounts: query(sourceRoot, OBJECT_COUNTS_SQL, "object_counts", env),
      functionState: null,
      triggerState: null,
      catalogState: null,
      scheduleWindowManifest: null,
      criticalSurfaceManifest: null,
      v26ExpectationState: null,
      v27ExpectationState: null,
      v28ExpectationState: null,
      v29ExpectationState: null,
      v29TransitionManifest: null,
      v29OperationalContract: null,
      v29OperationalManifest: null,
      v30ExpectationState: null,
      v30ReplayRepairsManifest: null,
      v30OperationalContract: null,
      v30OperationalManifest: null,
      v31ExpectationState: null,
      v31ResourceOwnershipManifest: null,
      v31OperationalContract: null,
      v31OperationalManifest: null,
      v35EvidenceManifest: null,
      v36RecoveryManifest: null,
      operationalReadiness: null,
      writerReturnContractState: null,
    };
    if (snapshot.history === packet.postHistory && snapshot.objectCounts === "3:1") {
      snapshot.functionState = query(
        sourceRoot,
        FUNCTION_STATE_SQL,
        "function_state",
        env,
      );
      snapshot.triggerState = query(
        sourceRoot,
        TRIGGER_STATE_SQL,
        "trigger_state",
        env,
      );
      snapshot.catalogState = query(
        sourceRoot,
        CATALOG_STATE_SQL,
        "catalog_state",
        env,
      );
      snapshot.v35EvidenceManifest = query(
        sourceRoot,V35_EVIDENCE_MANIFEST_SQL,"v35_evidence_manifest",env,
      );
      snapshot.v36RecoveryManifest = query(
        sourceRoot,V36_RECOVERY_MANIFEST_SQL,"v36_recovery_manifest",env,
      );
      snapshot.criticalSurfaceManifest = query(
        sourceRoot,
        CRITICAL_SURFACE_MANIFEST_SQL,
        "critical_surface_manifest",
        env,
      );
      snapshot.v26ExpectationState = query(
        sourceRoot,
        V26_EXPECTATION_STATE_SQL,
        "v26_expectation_state",
        env,
      );
      snapshot.v27ExpectationState = query(
        sourceRoot,
        V27_EXPECTATION_STATE_SQL,
        "v27_expectation_state",
        env,
      );
      snapshot.v28ExpectationState = query(
        sourceRoot,
        V28_EXPECTATION_STATE_SQL,
        "v28_expectation_state",
        env,
      );
      snapshot.v29ExpectationState = query(
        sourceRoot,
        V29_EXPECTATION_STATE_SQL,
        "v29_expectation_state",
        env,
      );
      snapshot.v29TransitionManifest = query(
        sourceRoot,
        V29_TRANSITION_MANIFEST_SQL,
        "v29_transition_manifest",
        env,
      );
      snapshot.v29OperationalContract = query(
        sourceRoot,
        V29_OPERATIONAL_CONTRACT_SQL,
        "v29_operational_contract",
        env,
      );
      snapshot.v29OperationalManifest = query(
        sourceRoot,
        V29_OPERATIONAL_MANIFEST_SQL,
        "v29_operational_manifest",
        env,
      );
      snapshot.v30ExpectationState = query(
        sourceRoot,
        V30_EXPECTATION_STATE_SQL,
        "v30_expectation_state",
        env,
      );
      snapshot.v30ReplayRepairsManifest = query(
        sourceRoot,
        V30_REPLAY_REPAIRS_MANIFEST_SQL,
        "v30_replay_repairs_manifest",
        env,
      );
      snapshot.v30OperationalContract = query(
        sourceRoot,
        V30_OPERATIONAL_CONTRACT_SQL,
        "v30_operational_contract",
        env,
      );
      snapshot.v30OperationalManifest = query(
        sourceRoot,
        V30_OPERATIONAL_MANIFEST_SQL,
        "v30_operational_manifest",
        env,
      );
      snapshot.v31ExpectationState = query(
        sourceRoot,
        V31_EXPECTATION_STATE_SQL,
        "v31_expectation_state",
        env,
      );
      snapshot.v31ResourceOwnershipManifest = query(
        sourceRoot,
        V31_RESOURCE_OWNERSHIP_MANIFEST_SQL,
        "v31_resource_ownership_manifest",
        env,
      );
      snapshot.v31OperationalContract = query(
        sourceRoot,
        V31_OPERATIONAL_CONTRACT_SQL,
        "v31_operational_contract",
        env,
      );
      snapshot.v31OperationalManifest = query(
        sourceRoot,
        V31_OPERATIONAL_MANIFEST_SQL,
        "v31_operational_manifest",
        env,
      );
    }
    if (
      snapshot.objectCounts === "3:1" &&
      (snapshot.history === packet.v31History ||
       snapshot.history === packet.v32History ||
       snapshot.history === packet.v33History ||
       snapshot.history === packet.v34History ||
       snapshot.history === packet.v35History)
    ) {
      snapshot.catalogState = query(sourceRoot, CATALOG_STATE_SQL, "catalog_state", env);
    }
    if (
      snapshot.history === packet.scheduleV25History &&
      snapshot.objectCounts === "3:1"
    ) {
      snapshot.catalogState = query(
        sourceRoot,
        SCHEDULE_V25_CATALOG_STATE_SQL,
        "catalog_state",
        env,
      );
      snapshot.scheduleWindowManifest = query(
        sourceRoot,
        SCHEDULE_WINDOW_MANIFEST_SQL,
        "schedule_window_manifest",
        env,
      );
    }
    if (
      snapshot.objectCounts === "3:1" &&
      (
        snapshot.history === ROLLOUT.preHistory ||
        snapshot.history === packet.intermediateHistory ||
        snapshot.history === packet.recoveryHistory ||
        snapshot.history === packet.convergenceHistory ||
        snapshot.history === packet.attestedHistory ||
        snapshot.history === packet.returnAttestedHistory ||
        snapshot.history === packet.retainedHistory ||
        snapshot.history === packet.criticalHistory ||
        snapshot.history === packet.columnAttestedHistory ||
        snapshot.history === packet.trialLockedHistory ||
        snapshot.history === packet.staffIdentityHistory ||
        snapshot.history === packet.restoredV22History ||
        snapshot.history === packet.canonicalV23History ||
        snapshot.history === packet.v24History ||
        snapshot.history === packet.scheduleV25History ||
        snapshot.history === packet.v25History ||
        snapshot.history === packet.v26History ||
        snapshot.history === packet.v27History ||
        snapshot.history === packet.v28History ||
        snapshot.history === packet.v29History ||
        snapshot.history === packet.v30History ||
        snapshot.history === packet.v31History ||
        snapshot.history === packet.v32History ||
        snapshot.history === packet.v33History ||
        snapshot.history === packet.v34History ||
        snapshot.history === packet.v35History ||
        snapshot.history === packet.postHistory
      )
    ) {
      snapshot.operationalReadiness = query(
        sourceRoot,
        snapshot.history === packet.postHistory
          ? FINAL_OPERATIONAL_READINESS_SQL
          : snapshot.history === packet.v34History
            ? V34_OPERATIONAL_READINESS_SQL
          : snapshot.history === packet.v35History
            ? V35_OPERATIONAL_READINESS_SQL
          : snapshot.history === packet.v33History
            ? V33_OPERATIONAL_READINESS_SQL
          : snapshot.history === packet.v32History
            ? V32_OPERATIONAL_READINESS_SQL
          : snapshot.history === packet.v31History
            ? V31_OPERATIONAL_READINESS_SQL
          : snapshot.history === packet.v30History
            ? V30_OPERATIONAL_READINESS_SQL
          : snapshot.history === packet.v29History
            ? V29_OPERATIONAL_READINESS_SQL
          : snapshot.history === packet.v28History
            ? V28_OPERATIONAL_READINESS_SQL
          : snapshot.history === packet.v27History
            ? V27_OPERATIONAL_READINESS_SQL
          : snapshot.history === packet.v26History
            ? V26_OPERATIONAL_READINESS_SQL
          : snapshot.history === packet.v25History
            ? V25_OPERATIONAL_READINESS_SQL
          : snapshot.history === packet.scheduleV25History
            ? SCHEDULE_V25_OPERATIONAL_READINESS_SQL
          : snapshot.history === packet.trialLockedHistory ||
        snapshot.history === packet.staffIdentityHistory ||
        snapshot.history === packet.restoredV22History ||
        snapshot.history === packet.canonicalV23History ||
        snapshot.history === packet.v24History
          ? OPERATIONAL_READINESS_SQL
          : PREDECESSOR_OPERATIONAL_READINESS_SQL,
        "operational_readiness",
        env,
      );
    }
    if (
      snapshot.objectCounts === "3:1" &&
      (snapshot.history === packet.attestedHistory ||
       snapshot.history === packet.returnAttestedHistory ||
       snapshot.history === packet.retainedHistory ||
       snapshot.history === packet.criticalHistory ||
       snapshot.history === packet.columnAttestedHistory)
    ) {
      snapshot.writerReturnContractState = query(
        sourceRoot,
        WRITER_RETURN_CONTRACT_STATE_SQL,
        "writer_return_contract_state",
        env,
      );
    }
  } catch (error) {
    if (!(error instanceof RolloutError)) {
      throw error;
    }
    return {
      state: "unknown",
      reason: error.message.includes("UNKNOWN(timeout)") ? "timeout" : "connectivity",
    };
  }
  try {
    return classifyStateSnapshot(
      { ...snapshot, historyColumns: parseHistoryColumns(snapshot.historyColumns) },
      packet,
      expectedProviderFingerprint,
    );
  } catch (error) {
    if (!(error instanceof RolloutError)) {
      throw error;
    }
    return { state: "diverged", detail: error.message };
  }
}

function parseHistoryColumns(value) {
  let columns;
  try {
    columns = JSON.parse(value);
  } catch {
    throw new RolloutError("history_columns query returned malformed JSON.");
  }
  if (!Array.isArray(columns)) {
    throw new RolloutError("history_columns query returned an unexpected JSON shape.");
  }
  return columns;
}

function validateMigrationRowCount(value) {
  if (!/^(?:0|[1-9][0-9]*)$/.test(value)) {
    throw new RolloutError("migration_row_count query returned a non-integer value.");
  }
  return value;
}

function validateMigrationNewestVersion(value) {
  if (typeof value !== "string" || /[\r\n\x00-\x1f\x7f]/.test(value)) {
    throw new RolloutError("migration_newest_version query returned a noncanonical value.");
  }
  return value;
}

export function readRemoteDiagnosis(
  sourceRoot,
  packet,
  env,
  query = querySingleValue,
) {
  let historyColumnsActual = null;
  const classification = readRemoteState(
    sourceRoot,
    packet,
    env,
    null,
    (queryRoot, sql, header, queryEnv) => {
      const value = query(queryRoot, sql, header, queryEnv);
      if (header === "history_columns") historyColumnsActual = value;
      return value;
    },
  );
  if (classification.state === "unknown") return classification;

  let migrationRowCount;
  let migrationNewestVersion;
  try {
    migrationRowCount = query(
      sourceRoot,
      MIGRATION_ROW_COUNT_SQL,
      "migration_row_count",
      env,
    );
    migrationNewestVersion = query(
      sourceRoot,
      MIGRATION_NEWEST_VERSION_SQL,
      "migration_newest_version",
      env,
    );
  } catch (error) {
    if (!(error instanceof RolloutError)) {
      throw error;
    }
    return {
      state: "unknown",
      reason: error.message.includes("UNKNOWN(timeout)") ? "timeout" : "connectivity",
    };
  }

  return {
    ...classification,
    historyColumns: JSON.stringify(parseHistoryColumns(historyColumnsActual)),
    migrationRowCount: validateMigrationRowCount(migrationRowCount),
    migrationNewestVersion: validateMigrationNewestVersion(migrationNewestVersion),
  };
}

export function formatDiagnosisReport({ target, projectRef, candidateSha }, diagnosis) {
  const lines = [
    `target=${target}`,
    `project_ref=${projectRef}`,
    `candidate_sha=${candidateSha}`,
    "remote_content_hashes=absent",
  ];
  const nonSuccessStateLine = formatNonSuccessProbeState(diagnosis);
  if (diagnosis.state === "unknown") {
    lines.push(nonSuccessStateLine);
    return lines.join("\n");
  }
  lines.push(
    `history_columns=${diagnosis.historyColumns}`,
    `migration_row_count=${diagnosis.migrationRowCount}`,
    `migration_newest_version=${diagnosis.migrationNewestVersion}`,
    nonSuccessStateLine ?? `state=${diagnosis.state}`,
  );
  if (diagnosis.state === "post" && diagnosis.providerFingerprint) {
    lines.push(`provider_fingerprint=${diagnosis.providerFingerprint}`);
  }
  return lines.join("\n");
}

function assertLinkedProjectRef(sourceRoot, expectedRef) {
  const refPath = path.join(sourceRoot, "supabase", ".temp", "project-ref");
  const raw = fs.readFileSync(refPath, "utf8");
  if (raw !== expectedRef && raw !== `${expectedRef}\n`) {
    throw new RolloutError("Saved Supabase project ref is missing, noncanonical, or mismatched.");
  }
}

export function runDryRun(sourceRoot, packet, env) {
  const output = runCommand(
    "supabase",
    ["db", "push", "--linked", "--dry-run", "--agent=no"],
    {
      cwd: sourceRoot,
      env,
      label: "Supabase migration dry-run",
      capture: "stderr",
    },
  );
  return assertExactPendingMigrations(output, packet);
}

export function buildProductionConfirmationPhrase(packet) {
  return [
    "APPLY",
    packet.pendingMigrations.length,
    "MIGRATIONS FROM",
    packet.candidateSha,
    "MANIFEST",
    packet.sourceManifestSha256,
    "TO",
    ROLLOUT.productionRef,
  ].join(" ");
}

async function confirmProductionApply(packet) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new RolloutError("Production apply requires an interactive human terminal.");
  }
  const expected = buildProductionConfirmationPhrase(packet);
  const prompt = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await prompt.question(`Type exactly '${expected}' to continue: `);
  prompt.close();
  if (answer !== expected) {
    throw new RolloutError("Production confirmation did not match exactly.");
  }
}

function usage() {
  return `Usage:
  node scripts/studio-comp-migration-rollout.mjs --mode packet --candidate-sha <full-sha>
  node scripts/studio-comp-migration-rollout.mjs --target <staging|production> --candidate-sha <full-sha> [--mode <inspect|diagnose|dry-run|apply>]

diagnose performs linked, read-only SELECT diagnosis and needs no inspection token.
Dry-run and apply require the inspection_token from a preceding inspect. Apply additionally requires:
  --confirm-project <exact-ref> --approval-record <exact-PR-138-issue-comment-url>
  staging:    --approve-staging-apply
  production: --human-production-operator --expected-provider-fingerprint <staging-fingerprint>
              --confirmed-restore-window <window-or-record>
              --restore-decision-authority <named-person>

inspect is the default mode. Agents must never use production apply.`;
}

export async function main(
  argv = process.argv.slice(2),
  env = process.env,
  {
    commandRunner = runCommand,
    sourceVerifier = verifySourceTree,
    linkedRefAsserter = assertLinkedProjectRef,
    diagnosisReader = readRemoteDiagnosis,
    output = console.log,
  } = {},
) {
  const config = parseArguments(argv);
  validateApplyAuthorization(config);

  if (config.mode !== "packet") {
    assertSafeCredentialedTransport(env);
  }

  const cliVersion = commandRunner("supabase", ["--version"], {
    env,
    label: "Supabase CLI version read",
  })
    .split("\n")[0];
  if (cliVersion !== ROLLOUT.cliVersion) {
    throw new RolloutError(
      `Supabase CLI version mismatch: expected ${ROLLOUT.cliVersion}, found ${cliVersion}.`,
    );
  }

  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "koaryu-studio-comp-rollout-"));
  const sourceRoot = path.join(temporaryRoot, "candidate");
  let worktreeAdded = false;
  try {
    commandRunner("git", ["worktree", "add", "--detach", sourceRoot, config.candidateSha], {
      label: "detached candidate worktree creation",
    });
    worktreeAdded = true;
    const packet = sourceVerifier(sourceRoot, config.candidateSha);
    if (config.mode === "packet") {
      console.log(`candidate_sha=${packet.candidateSha}`);
      console.log(`cli_version=${ROLLOUT.cliVersion}`);
      console.log(`pre_history=${ROLLOUT.preHistory}`);
      console.log(`post_history=${packet.postHistory}`);
      console.log(`pending_migrations=${packet.pendingMigrations.join(",")}`);
      console.log(`source_manifest_sha256=${packet.sourceManifestSha256}`);
      console.log(`integration_complete=${packet.integrationComplete}`);
      console.log("remote_content_hashes=absent");
      return;
    }

    const projectRef = config.target === "staging" ? ROLLOUT.stagingRef : ROLLOUT.productionRef;
    if (config.mode !== "diagnose" && !packet.integrationComplete) {
      throw new RolloutError(
        `Provider inspection requires the exact final ${ROLLOUT.finalMigrationCount}-migration candidate through ${ROLLOUT.finalMigrationVersion}.`,
      );
    }
    commandRunner(
      "supabase",
      ["link", "--project-ref", projectRef, "--yes", "--agent=no"],
      { cwd: sourceRoot, env, label: "Supabase project link" },
    );
    linkedRefAsserter(sourceRoot, projectRef);

    if (config.mode === "diagnose") {
      const diagnosis = diagnosisReader(sourceRoot, packet, env);
      const report = formatDiagnosisReport(
        {
          target: config.target,
          projectRef,
          candidateSha: packet.candidateSha,
        },
        diagnosis,
      );
      for (const line of report.split("\n")) output(line);
      if (diagnosis.state === "unknown") {
        throw new RolloutError(`Diagnosis refused: ${formatNonSuccessProbeState(diagnosis)}.`);
      }
      return;
    }

    const before = readRemoteState(
      sourceRoot,
      packet,
      env,
      config.mode === "inspect" ? config.expectedProviderFingerprint : null,
    );
    const nonSuccessStateLine = formatNonSuccessProbeState(before);
    if (config.mode === "inspect") {
      console.log(`target=${config.target}`);
      console.log(`project_ref=${projectRef}`);
      console.log(`candidate_sha=${packet.candidateSha}`);
      console.log(`post_history=${packet.postHistory}`);
      console.log(`pending_migrations=${packet.pendingMigrations.join(",")}`);
      console.log(`source_manifest_sha256=${packet.sourceManifestSha256}`);
      console.log("remote_content_hashes=absent");
      if (nonSuccessStateLine !== null) {
        console.log(nonSuccessStateLine);
        throw new RolloutError(`Inspection refused: ${nonSuccessStateLine}.`);
      }
      const inspectionToken = buildInspectionTokenForAcceptedState(packet, config.target, before);
      console.log(`state=${before.state}`);
      console.log(`inspection_token=${inspectionToken}`);
      if (before.state !== "post") {
        const remainingPacket = packetForAcceptedState(packet, before.state);
        console.log(`remaining_migrations=${remainingPacket.pendingMigrations.join(",")}`);
        console.log(`remaining_manifest_sha256=${remainingPacket.sourceManifestSha256}`);
        console.log("approval_record_body_begin");
        console.log(buildApplyApprovalRecordBody(remainingPacket, config.target, before.state));
        console.log("approval_record_body_end");
      }
      if (before.providerFingerprint) {
        console.log(`provider_fingerprint=${before.providerFingerprint}`);
      }
      return;
    }
    if (nonSuccessStateLine !== null) {
      console.log(nonSuccessStateLine);
      throw new RolloutError(
        `${config.mode} requires the exact ${ROLLOUT.baselineMigrationCount}-migration pre-state.`,
      );
    }
    if (
      before.state !== "pre" &&
      before.state !== "intermediate" &&
      before.state !== "recovery" &&
      before.state !== "convergence" &&
      before.state !== "attested" &&
      before.state !== "return-attested" &&
      before.state !== "retained" &&
      before.state !== "critical" &&
      before.state !== "column-attested" &&
      before.state !== "trial-locked" &&
      before.state !== "staff-identity" &&
      before.state !== "restored-v22" &&
      before.state !== "canonical-v23" &&
      before.state !== "restored-v23-pending-v24" &&
      before.state !== "v24" &&
      before.state !== "schedule-v25" &&
      before.state !== "v25" &&
      before.state !== "v26" &&
      before.state !== "v27" &&
      before.state !== "v28" &&
      before.state !== "v29" &&
      before.state !== "v30"
      && before.state !== "v31"
      && before.state !== "v32"
      && before.state !== "v33"
      && before.state !== "v34"
      && before.state !== "v35"
    ) {
      throw new RolloutError(
        `${config.mode} requires an exact accepted pre-, intermediate-, recovery-, convergence-, attested-, return-attested-, retained, critical, column-attested, trial-locked, staff-identity, restored-v22, canonical-v23, restored-v23-pending-v24, v24, schedule-v25, v25, v26, v27, v28, v29, v30, v31, v32, v33, v34, or v35 state.`,
      );
    }
    assertInspectionToken(packet, config.target, before, config.inspectionToken);

    const remainingPacket = packetForAcceptedState(packet, before.state);
    validateApplyApprovalRecord(config, remainingPacket, before.state, commandRunner, env);
    const pending = runDryRun(sourceRoot, remainingPacket, env);
    console.log(`dry_run_migrations=${pending.join(",")}`);
    if (config.mode === "dry-run") return;

    assertApplyableState(config.mode, before.state);

    if (config.target === "production") {
      await confirmProductionApply(remainingPacket);
    }
    try {
      runCommand("supabase", ["db", "push", "--linked", "--agent=no"], {
        cwd: sourceRoot,
        env,
        label: "Supabase migration apply",
      });
    } catch (error) {
      throw new RolloutError(
        `Migration apply failed and may have changed remote state. Stop and inspect; do not revert history or objects. ${error.message}`,
      );
    }
    const after = readRemoteState(sourceRoot, packet, env, config.expectedProviderFingerprint);
    const nonSuccessAfterStateLine = formatNonSuccessProbeState(after);
    if (nonSuccessAfterStateLine !== null) {
      console.log(nonSuccessAfterStateLine);
    }
    if (after.state !== "post") {
      throw new RolloutError("Migration apply did not reach the exact expected post-state.");
    }
    console.log(`target=${config.target}`);
    console.log(`project_ref=${projectRef}`);
    console.log(`candidate_sha=${packet.candidateSha}`);
    console.log(`post_history=${packet.postHistory}`);
    console.log(`source_manifest_sha256=${packet.sourceManifestSha256}`);
    console.log("state=post");
    console.log(`provider_fingerprint=${after.providerFingerprint}`);
  } finally {
    if (worktreeAdded) {
      spawnSync("git", ["worktree", "remove", "--force", sourceRoot], {
        cwd: REPOSITORY_ROOT,
        encoding: "utf8",
        stdio: "ignore",
      });
    }
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`Studio-comp migration rollout refused: ${error.message}`);
    console.error(usage());
    process.exitCode = error instanceof RolloutError ? 1 : 2;
  });
}
