import {
  Address,
  Blockchain,
  BytesWriter,
  Calldata,
  OP_NET,
  encodeSelector,
  Selector,
  NetEvent,
  StoredU256,
  AddressMemoryMap,
} from '@btc-vision/btc-runtime/runtime';
import { u256 } from 'as-bignum/assembly';

// ─── Events ───────────────────────────────────────────────────────────────────

class MemeCreatedEvent extends NetEvent {
  constructor(
    creator: Address,
    tokenAddress: Address,
    revenueSharingAddress: Address,
    name: string,
    symbol: string
  ) {
    const nameBytes = String.UTF8.encode(name);
    const symbolBytes = String.UTF8.encode(symbol);
    const writer = new BytesWriter(32 + 32 + 32 + 2 + nameBytes.byteLength + 2 + symbolBytes.byteLength);
    writer.writeAddress(creator);
    writer.writeAddress(tokenAddress);
    writer.writeAddress(revenueSharingAddress);
    writer.writeStringWithLength(name);
    writer.writeStringWithLength(symbol);
    super('MemeCreated', writer);
  }
}

// ─── MemeFactory Contract ─────────────────────────────────────────────────────
//
// Factory cho phép bất kỳ ai tạo meme token + revenue sharing contract
// Mỗi lần tạo:
//   1. Deploy RevenueSharing contract (100 slots, auction 144 blocks)
//   2. Deploy MemeToken với 1% fee → gửi vào RevenueSharing
//   3. Emit event để frontend biết địa chỉ 2 contract mới

@final
export class MemeFactory extends OP_NET {
  // Storage
  private static readonly TOTAL_MEMES_PTR: u16 = 400;
  private static readonly MEME_REGISTRY_PTR: u16 = 401; // index → tokenAddress
  private static readonly CREATOR_REGISTRY_PTR: u16 = 402; // tokenAddress → creator

  private _totalMemes: StoredU256 = new StoredU256(MemeFactory.TOTAL_MEMES_PTR, u256.Zero);

  private memeRegistry: AddressMemoryMap<u256> = new AddressMemoryMap<u256>(
    MemeFactory.MEME_REGISTRY_PTR
  );
  private creatorRegistry: AddressMemoryMap<u256> = new AddressMemoryMap<u256>(
    MemeFactory.CREATOR_REGISTRY_PTR
  );

  public constructor() {
    super();
  }

  public override onDeployment(_calldata: Calldata): void {
    // Factory không cần init gì đặc biệt
  }

  public override execute(method: Selector, calldata: Calldata): BytesWriter {
    switch (method) {
      case encodeSelector('createMeme(string,string)'):
        return this.createMeme(calldata);
      case encodeSelector('getMemeCount()'):
        return this.getMemeCount();
      case encodeSelector('getMemeAt(uint256)'):
        return this.getMemeAt(calldata);
      default:
        return super.execute(method, calldata);
    }
  }

  // ─── createMeme: tạo mới một meme token + revenue sharing ─────────────────
  //
  // Lưu ý: Trên OP_NET, không thể deploy contract từ trong contract
  // như Solidity (không có CREATE opcode). Thay vào đó:
  //
  // Cách 1 (đơn giản): Factory CHỈ lưu registry, việc deploy 2 contract
  //   (MemeToken + RevenueSharing) được thực hiện off-chain bởi user,
  //   sau đó user gọi "registerMeme" để đăng ký vào Factory.
  //
  // Cách 2 (nâng cao): Dùng OP_NET's contract spawning nếu runtime hỗ trợ.
  //
  // → Implement Cách 1 (phù hợp với OP_NET hiện tại)

  private createMeme(calldata: Calldata): BytesWriter {
    // Nhận địa chỉ 2 contract đã được deploy sẵn
    const tokenAddress: Address = calldata.readAddress();
    const revenueSharingAddress: Address = calldata.readAddress();
    const name: string = calldata.readStringWithLength();
    const symbol: string = calldata.readStringWithLength();

    const creator: Address = Blockchain.tx.sender;

    // Lưu vào registry
    const index = this._totalMemes.value;
    const tokenBytes = u256.fromBytes(tokenAddress.toBytes(), true);
    const revBytes = u256.fromBytes(revenueSharingAddress.toBytes(), true);

    this.memeRegistry.set(index, tokenBytes);
    this.creatorRegistry.set(tokenBytes, revBytes);

    // Tăng counter
    this._totalMemes.value = u256.add(index, u256.One);

    this.emitEvent(new MemeCreatedEvent(
      creator,
      tokenAddress,
      revenueSharingAddress,
      name,
      symbol
    ));

    const writer = new BytesWriter(32 + 32);
    writer.writeAddress(tokenAddress);
    writer.writeAddress(revenueSharingAddress);
    return writer;
  }

  private getMemeCount(): BytesWriter {
    const writer = new BytesWriter(32);
    writer.writeU256(this._totalMemes.value);
    return writer;
  }

  private getMemeAt(calldata: Calldata): BytesWriter {
    const index: u256 = calldata.readU256();
    const tokenBytes = this.memeRegistry.get(index);

    assert(tokenBytes !== null, 'Meme not found at this index');

    const tokenAddr = Address.fromBytes(tokenBytes!.toBytes());
    const revBytes = this.creatorRegistry.get(tokenBytes!);

    const writer = new BytesWriter(32 + 32);
    writer.writeAddress(tokenAddr);

    if (revBytes !== null) {
      writer.writeAddress(Address.fromBytes(revBytes!.toBytes()));
    } else {
      writer.writeAddress(Address.dead());
    }

    return writer;
  }
}
