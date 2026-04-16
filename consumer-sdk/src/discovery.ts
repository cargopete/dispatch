import type { Provider, CapabilityTier } from "./types.js";

const PROVIDERS_QUERY = `
  query Providers($chainId: BigInt!, $tier: Int!) {
    indexers(where: { registered: true }) {
      id
      address
      geoHash
      paymentsDestination
      chains(where: { active: true, chainId: $chainId, tier: $tier }) {
        chainId
        tier
        endpoint
      }
    }
  }
`;

interface SubgraphChain {
  chainId: string;
  tier: number;
  endpoint: string;
}

interface SubgraphIndexer {
  id: string;
  address: string;
  geoHash: string;
  paymentsDestination: string;
  chains: SubgraphChain[];
}

interface SubgraphResponse {
  data?: { indexers: SubgraphIndexer[] };
  errors?: { message: string }[];
}

/**
 * Query the Dispatch subgraph for active providers serving a given chain and tier.
 *
 * Providers are returned with a default `qosScore` of 0.5.
 * The caller is responsible for updating scores based on observed latency.
 */
export async function discoverProviders(
  subgraphUrl: string,
  chainId: number,
  tier: CapabilityTier
): Promise<Provider[]> {
  const response = await fetch(subgraphUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      query: PROVIDERS_QUERY,
      variables: { chainId: chainId.toString(), tier },
    }),
  });

  if (!response.ok) {
    throw new Error(`Subgraph query failed: ${response.status} ${response.statusText}`);
  }

  const body = (await response.json()) as SubgraphResponse;

  if (body.errors?.length) {
    throw new Error(`Subgraph errors: ${body.errors.map((e) => e.message).join(", ")}`);
  }

  const indexers = body.data?.indexers ?? [];

  return indexers
    .filter((idx) => idx.chains.length > 0)
    .map((idx) => ({
      address: idx.address as `0x${string}`,
      geoHash: idx.geoHash,
      paymentsDestination: idx.paymentsDestination as `0x${string}`,
      services: idx.chains.map((c) => ({
        chainId: Number(c.chainId),
        tier: c.tier as CapabilityTier,
        endpoint: c.endpoint,
      })),
      qosScore: 0.5,
    }));
}
