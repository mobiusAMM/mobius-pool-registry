import { ChainId, Multicall } from "@dahlia-labs/celo-contrib";
import { StablePools } from "@dahlia-labs/mobius-config-registry";
import type { Interface, Result } from "@ethersproject/abi";
import { getAddress } from "@ethersproject/address";
import { AddressZero } from "@ethersproject/constants";
import type { ContractInterface } from "@ethersproject/contracts";
import { Contract } from "@ethersproject/contracts";
import type { JsonRpcProvider } from "@ethersproject/providers";
import { StaticJsonRpcProvider } from "@ethersproject/providers";
import type { BigNumber } from "ethers";
import * as fs from "fs/promises";
import { chunk } from "lodash";
import invariant from "tiny-invariant";

import MULTICALL_ABI from "./abis/multicall2.json";
import SWAP_ABI from "./abis/Swap.json";
import type { Multicall2, Swap } from "./generated";

const MAX_CHUNK = 100;
export interface Call {
  target: string;
  callData: string;
}

// returns the checksummed address if the address is valid, otherwise returns false
export function isAddress(value: string): string | false {
  try {
    return getAddress(value);
  } catch {
    return false;
  }
}

export const parseFunctionReturn = (
  _interface: Interface,
  func: string,
  returnData: string | undefined | unknown
): Result => {
  invariant(typeof returnData === "string", "return data not found");
  return _interface.decodeFunctionResult(func, returnData);
};

// account is optional
export function getContract(
  address: string,
  ABI: ContractInterface,
  provider: JsonRpcProvider
): Contract {
  if (!isAddress(address)) {
    throw Error(`Invalid 'address' parameter '${address}'.`);
  }
  return new Contract(address, ABI, provider);
}

function useContract(
  address: string | undefined,
  ABI: ContractInterface,
  provider: JsonRpcProvider
): Contract | null {
  if (!address || !ABI) return null;
  try {
    return getContract(address, ABI, provider);
  } catch (error) {
    console.error("Failed to get contract", error);
    return null;
  }
}
export function useSwapContract(
  address: string,
  provider: JsonRpcProvider
): Swap | null {
  return useContract(address, SWAP_ABI.abi, provider) as Swap | null;
}

export function useMulticall(provider: JsonRpcProvider): Multicall2 | null {
  return useContract(
    Multicall[ChainId.Mainnet],
    MULTICALL_ABI,
    provider
  ) as Multicall2 | null;
}

export const fetchAllPools = async (): Promise<void> => {
  const provider = new StaticJsonRpcProvider("https://forno.celo.org");

  const multicall = useMulticall(provider);
  const swapContract = useSwapContract(AddressZero, provider);

  invariant(multicall && swapContract);

  const getMulticallDataChunked = async (calls: Call[]) => {
    const callChunks = chunk(calls, MAX_CHUNK);
    return (
      await Promise.all(
        callChunks.map((c) => multicall.callStatic.aggregate(c))
      )
    ).flatMap((c) => c.returnData);
  };

  const calls: Call[] = StablePools[ChainId.Mainnet].flatMap((p) => [
    {
      target: p.pool.address,
      callData: swapContract.interface.encodeFunctionData("getA"),
    },
    {
      target: p.pool.address,
      callData: swapContract.interface.encodeFunctionData("swapStorage"),
    },
    {
      target: p.pool.address,
      callData: swapContract.interface.encodeFunctionData("paused"),
    },
  ]);

  const poolData = await getMulticallDataChunked(calls);

  interface Swap {
    swapFee: BigNumber;
    adminFee: BigNumber;
    defaultDepositFee: BigNumber;
    defaultWithdrawFee: BigNumber;
  }

  const pools = chunk(poolData, 3).map((pd) => {
    const amp = parseFunctionReturn(swapContract.interface, "getA", pd[0]);
    const swap = parseFunctionReturn(
      swapContract.interface,
      "swapStorage",
      pd[1]
    ) as unknown as Swap;
    const paused = parseFunctionReturn(
      swapContract.interface,
      "paused",
      pd[2]
    ) as [boolean];
    return {
      ampFactor: amp.toString(),
      paused: paused[0] === true,
      fees: {
        trade: swap.swapFee.toString(),
        admin: swap.adminFee.toString(),
        deposit: swap.defaultDepositFee.toString(),
        withdraw: swap.defaultWithdrawFee.toString(),
      },
    };
  });

  await fs.writeFile("data/pools.json", JSON.stringify(pools, null, 2));

  console.log(`Discovered and wrote ${pools.length} pools`);
};

fetchAllPools().catch((err) => {
  console.error(err);
});
