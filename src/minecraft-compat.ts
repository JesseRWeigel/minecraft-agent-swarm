import minecraftData from "minecraft-data";
import minecraftProtocol from "minecraft-protocol";

/** The bot speaks a client protocol, which may differ from the Paper server version. */
export function resolveMinecraftProtocolVersion(
  serverVersion: string,
  protocolVersion?: string,
  viaBackwards = false,
): string {
  const clientVersion = protocolVersion || serverVersion;
  if (serverVersion === "26.3") {
    if (clientVersion !== "26.1" || !viaBackwards) {
      throw new Error(
        "Paper 26.3 is not yet natively supported by minecraft-data/minecraft-protocol. " +
          "Use a separate Paper 26.3 test server with ViaVersion + ViaBackwards, " +
          "and set MC_PROTOCOL_VERSION=26.1 and MC_VIABACKWARDS=true. " +
          "Do not set MC_VERSION=26.1 to disguise a 26.3 server.",
      );
    }
  } else if (protocolVersion && protocolVersion !== serverVersion) {
    throw new Error("MC_PROTOCOL_VERSION may differ from MC_VERSION only for the documented Paper 26.3 bridge.");
  }

  if (!minecraftProtocol.supportedVersions.includes(clientVersion) || !minecraftData(clientVersion)) {
    throw new Error(
      `Minecraft client protocol ${clientVersion} is unsupported by installed PrismarineJS dependencies.`,
    );
  }
  if (serverVersion === "26.3" && !minecraftData(clientVersion)?.supportFeature("sendsClientTickEndPacket")) {
    throw new Error("The selected client protocol cannot send client_tick_end, required by Paper 26.3.");
  }
  return clientVersion;
}
