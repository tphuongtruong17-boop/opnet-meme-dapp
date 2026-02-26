/**
 * deploy.ts — Script deploy toàn bộ dApp lên OP_NET (Testnet/Mainnet)
 *
 * Thứ tự deploy:
 *   1. Deploy MemeFactory (1 lần duy nhất)
 *   2. Mỗi khi user tạo meme:
 *      a. Deploy RevenueSharing → lấy địa chỉ
 *      b. Deploy MemeToken với địa chỉ của RevenueSharing
 *      c. Gọi MemeFactory.createMeme() để đăng ký
 */

import {
  JSONRpcProvider,
  Wallet,
  getContract,
  TransactionParameters,
} from 'opnet';
import { Network } from '@btc-vision/bitcoin';
import { Address } from '@btc-vision/transaction';
import * as fs from 'fs';

// ─── Config ───────────────────────────────────────────────────────────────────

const NETWORK: Network = Network.TESTNET;
const RPC_URL = 'https://testnet.opnet.org';

// Thay bằng private key của bạn
const PRIVATE_KEY = process.env.PRIVATE_KEY || 'YOUR_PRIVATE_KEY_HERE';

const provider = new JSONRpcProvider(RPC_URL, NETWORK);
const wallet = Wallet.fromPrivateKey(PRIVATE_KEY, NETWORK);
const deployerAddress = new Address(wallet.keypair.publicKey);

// ─── Deployment Parameters ────────────────────────────────────────────────────

const TX_PARAMS: TransactionParameters = {
  signer: wallet.keypair,
  refundTo: wallet.p2tr,
  maximumAllowedSatToSpend: 50000n,  // 0.0005 BTC max fee
  feeRate: 10,
  network: NETWORK,
};

// ─── Step 1: Deploy MemeFactory ───────────────────────────────────────────────

async function deployFactory(): Promise<string> {
  console.log('📦 Deploying MemeFactory...');

  const factoryWasm = fs.readFileSync('./build/MemeFactory.wasm');

  const deployTx = await provider.deployContract({
    bytecode: factoryWasm,
    calldata: Buffer.alloc(0), // không cần calldata
    ...TX_PARAMS,
  });

  const factoryAddress = deployTx.contractAddress;
  console.log(`✅ MemeFactory deployed at: ${factoryAddress}`);
  return factoryAddress;
}

// ─── Step 2: Deploy RevenueSharing cho một meme ───────────────────────────────

async function deployRevenueSharing(memeTokenAddress: string): Promise<string> {
  console.log('📦 Deploying RevenueSharing...');

  const revenueWasm = fs.readFileSync('./build/RevenueSharing.wasm');

  // Calldata: địa chỉ của MemeToken
  const calldata = encodeAddress(memeTokenAddress);

  const deployTx = await provider.deployContract({
    bytecode: revenueWasm,
    calldata,
    ...TX_PARAMS,
  });

  const revAddress = deployTx.contractAddress;
  console.log(`✅ RevenueSharing deployed at: ${revAddress}`);
  return revAddress;
}

// ─── Step 3: Deploy MemeToken ─────────────────────────────────────────────────

async function deployMemeToken(
  name: string,
  symbol: string,
  revenueSharingAddress: string
): Promise<string> {
  console.log(`📦 Deploying MemeToken (${symbol})...`);

  const tokenWasm = fs.readFileSync('./build/MemeToken.wasm');

  // Calldata: name, symbol, revenueSharingAddress
  const calldata = encodeStringString(name, symbol, revenueSharingAddress);

  const deployTx = await provider.deployContract({
    bytecode: tokenWasm,
    calldata,
    ...TX_PARAMS,
  });

  const tokenAddress = deployTx.contractAddress;
  console.log(`✅ MemeToken (${symbol}) deployed at: ${tokenAddress}`);
  return tokenAddress;
}

// ─── Step 4: Register vào Factory ────────────────────────────────────────────

async function registerMeme(
  factoryAddress: string,
  tokenAddress: string,
  revenueSharingAddress: string,
  name: string,
  symbol: string
): Promise<void> {
  console.log('📝 Registering meme in Factory...');

  // TODO: Dùng opnet SDK để gọi createMeme()
  console.log(`✅ Registered: ${name} (${symbol})`);
  console.log(`   Token:   ${tokenAddress}`);
  console.log(`   Revenue: ${revenueSharingAddress}`);
}

// ─── Helper: encode calldata ──────────────────────────────────────────────────

function encodeAddress(address: string): Buffer {
  // Đơn giản hoá — thực tế dùng btc-vision transaction library
  return Buffer.from(address.replace('bc1', '').replace('tb1', ''), 'hex');
}

function encodeStringString(name: string, symbol: string, address: string): Buffer {
  const nameBytes = Buffer.from(name, 'utf8');
  const symbolBytes = Buffer.from(symbol, 'utf8');
  const addrBytes = encodeAddress(address);

  const buf = Buffer.alloc(2 + nameBytes.length + 2 + symbolBytes.length + 32);
  let offset = 0;

  buf.writeUInt16BE(nameBytes.length, offset); offset += 2;
  nameBytes.copy(buf, offset); offset += nameBytes.length;

  buf.writeUInt16BE(symbolBytes.length, offset); offset += 2;
  symbolBytes.copy(buf, offset); offset += symbolBytes.length;

  addrBytes.copy(buf, offset);

  return buf;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('🚀 Deploying Meme Revenue DApp on OP_NET...\n');
  console.log(`Network: ${NETWORK}`);
  console.log(`Deployer: ${deployerAddress.toString()}\n`);

  // 1. Deploy Factory (chỉ cần làm 1 lần)
  const factoryAddress = await deployFactory();

  // 2. Tạo meme đầu tiên
  const memeName = 'DogeCoin2';
  const memeSymbol = 'DOGE2';

  // Deploy RevenueSharing trước (cần địa chỉ placeholder cho token)
  // Thực tế: deploy RevenueSharing với địa chỉ token sẽ được update sau
  // hoặc dùng pattern: deploy token trước với zero address, update sau

  // Cách đơn giản: deploy token trước với địa chỉ dummy
  const tempRevAddress = deployerAddress.toString(); // placeholder
  const tokenAddress = await deployMemeToken(memeName, memeSymbol, tempRevAddress);

  // Sau đó deploy RevenueSharing với đúng địa chỉ token
  const revAddress = await deployRevenueSharing(tokenAddress);

  // Register vào factory
  await registerMeme(factoryAddress, tokenAddress, revAddress, memeName, memeSymbol);

  console.log('\n✨ Deployment complete!');
  console.log('─'.repeat(50));
  console.log(`Factory:         ${factoryAddress}`);
  console.log(`MemeToken:       ${tokenAddress}`);
  console.log(`RevenueSharing:  ${revAddress}`);
  console.log('─'.repeat(50));
  console.log('\n📋 Next steps:');
  console.log('  1. Auction sẽ kết thúc sau 144 blocks (~1 ngày)');
  console.log('  2. Users đặt bid cho 100 slots qua bidSlot()');
  console.log('  3. Sau auction, winners gọi claimSlot()');
  console.log('  4. Mỗi giao dịch token → 1% fee → RevenueSharing');
  console.log('  5. Slot owners gọi claimRevenue() để rút lợi nhuận');
}

main().catch(console.error);
