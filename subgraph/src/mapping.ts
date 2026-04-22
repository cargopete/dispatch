import { BigInt } from "@graphprotocol/graph-ts";
import {
  ChainAdded,
  ChainRemoved,
  ProviderRegistered,
  ProviderDeregistered,
  PaymentsDestinationSet,
  ServiceStarted1 as ServiceStarted,
  ServiceStopped1 as ServiceStopped,
  MinThawingPeriodSet,
} from "../generated/RPCDataService/RPCDataService";
import {
  Indexer,
  ChainRegistration,
  SupportedChain,
  Protocol,
} from "../generated/schema";

function loadOrCreateProtocol(timestamp: BigInt): Protocol {
  let protocol = Protocol.load("1");
  if (protocol == null) {
    protocol = new Protocol("1");
    protocol.totalIndexers = 0;
    protocol.totalActiveRegistrations = 0;
    protocol.minThawingPeriod = BigInt.fromI32(1209600); // 14 days default
  }
  protocol.updatedAt = timestamp;
  return protocol;
}

export function handleProviderRegistered(event: ProviderRegistered): void {
  let id = event.params.provider.toHexString();
  let indexer = Indexer.load(id);
  if (indexer == null) {
    indexer = new Indexer(id);
    indexer.registeredAt = event.block.timestamp;
    let protocol = loadOrCreateProtocol(event.block.timestamp);
    protocol.totalIndexers = protocol.totalIndexers + 1;
    protocol.save();
  }
  indexer.address = event.params.provider;
  indexer.endpoint = event.params.endpoint;
  indexer.geoHash = event.params.geoHash;
  indexer.paymentsDestination = event.params.provider;
  indexer.registered = true;
  indexer.deregisteredAt = null;
  indexer.save();
}

export function handleProviderDeregistered(event: ProviderDeregistered): void {
  let id = event.params.provider.toHexString();
  let indexer = Indexer.load(id);
  if (indexer == null) return;
  indexer.registered = false;
  indexer.deregisteredAt = event.block.timestamp;
  indexer.save();
  let protocol = loadOrCreateProtocol(event.block.timestamp);
  protocol.totalIndexers = protocol.totalIndexers - 1;
  protocol.save();
}

export function handlePaymentsDestinationSet(event: PaymentsDestinationSet): void {
  let id = event.params.provider.toHexString();
  let indexer = Indexer.load(id);
  if (indexer == null) return;
  indexer.paymentsDestination = event.params.destination;
  indexer.save();
}

export function handleServiceStarted(event: ServiceStarted): void {
  let indexerId = event.params.provider.toHexString();
  let tierStr = BigInt.fromI32(event.params.tier).toString();
  let regId = indexerId + "-" + event.params.chainId.toString() + "-" + tierStr;

  let reg = ChainRegistration.load(regId);
  if (reg == null) {
    reg = new ChainRegistration(regId);
    reg.indexer = indexerId;
    reg.chainId = event.params.chainId;
    reg.tier = event.params.tier;
  }
  reg.endpoint = event.params.endpoint;
  reg.active = true;
  reg.startedAt = event.block.timestamp;
  reg.stoppedAt = null;
  reg.save();
  let protocol = loadOrCreateProtocol(event.block.timestamp);
  protocol.totalActiveRegistrations = protocol.totalActiveRegistrations + 1;
  protocol.save();
}

export function handleServiceStopped(event: ServiceStopped): void {
  let indexerId = event.params.provider.toHexString();
  let tierStr = BigInt.fromI32(event.params.tier).toString();
  let regId = indexerId + "-" + event.params.chainId.toString() + "-" + tierStr;

  let reg = ChainRegistration.load(regId);
  if (reg == null) return;
  reg.active = false;
  reg.stoppedAt = event.block.timestamp;
  reg.save();
  let protocol = loadOrCreateProtocol(event.block.timestamp);
  protocol.totalActiveRegistrations = protocol.totalActiveRegistrations - 1;
  protocol.save();
}

export function handleChainAdded(event: ChainAdded): void {
  let id = event.params.chainId.toString();
  let chain = SupportedChain.load(id);
  if (chain == null) {
    chain = new SupportedChain(id);
    chain.chainId = event.params.chainId;
  }
  chain.enabled = true;
  chain.minProvisionTokens = event.params.minProvisionTokens;
  chain.updatedAt = event.block.timestamp;
  chain.save();
}

export function handleChainRemoved(event: ChainRemoved): void {
  let id = event.params.chainId.toString();
  let chain = SupportedChain.load(id);
  if (chain == null) return;
  chain.enabled = false;
  chain.updatedAt = event.block.timestamp;
  chain.save();
}

export function handleMinThawingPeriodSet(event: MinThawingPeriodSet): void {
  let protocol = loadOrCreateProtocol(event.block.timestamp);
  protocol.minThawingPeriod = event.params.period;
  protocol.save();
}
