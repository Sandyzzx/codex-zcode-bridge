// Compatibility entry point. New execution-layer code imports the shared
// runtime contract directly so Adapter/Worker/Store do not depend on Host.
export {
  codexHostProfile,
  validateHostProfile,
  type BridgeHostProfile,
} from "../runtime/host-profile.js";
