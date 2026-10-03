# Milestone 1 — AAPLx-DEMO（2026-10-03）

用户明确要求进入下一阶段。M0 余额已由用户确认正常，真实 USDC A→B 转账仍未验收；不补记为通过。

## 本轮实现

- App 内使用 MWA 钱包签名创建 Devnet Token-2022 mint。`createAccountWithSeed` 从钱包公开地址和固定 seed 派生 mint；无需生成、保存或导入私钥。
- 一笔原子交易完成：分配 mint → 初始化 Scaled UI Amount → 初始化 mint → 创建钱包 ATA → 发行 500,000,000 raw units → 撤销 mint authority。
- decimals = 6，显示 multiplier = 2，因此初始显示 1,000 AAPLx-DEMO。freeze authority 与 multiplier authority 均为空。
- 相同钱包重试使用相同 mint 地址。链上已创建时验证并恢复，不再次发行；超时后公开 mint 地址已保存在设备，可刷新或用同一钱包重试。
- 可在另一设备粘贴同一 mint 地址加载，或通过 `EXPO_PUBLIC_AAPLX_DEMO_MINT` 打包为共享配置。
- USDC / AAPLx-DEMO 选择、余额、复核、钱包确认、Token-2022 转账、待确认恢复和链上收据校验。
- 1 显示单位对应 500,000 raw units；最小可转单位为 0.000002。不能精确表示的输入被拒绝，不静默舍入。
- Token-2022 ATA 的租金包括 ImmutableOwner 扩展，不能沿用传统 SPL Token 的 165 字节估算。

## 明确限制

这是 **Devnet demo asset / Not backed by real equity**。不是 Apple 股票，不是官方 xStocks；symbol/name 是 App 中的演示标签，没有创建链上 TokenMetadata 扩展。

本阶段只接受：6 decimals、不可变 ×2 multiplier、无增发/冻结权限、仅 ScaledUiAmountConfig mint 扩展。通过链上读取验证这些条件，而非只信任本地配置。可变 multiplier、非 2 系数、收费/转账钩子/其他 mint 扩展明确拒绝；这不是任意 Token-2022 或真实 xStocks 的通用实现。

选择多个 demo mint 时必须核对公开地址，名称相同不表示同一个资产。重启后恢复最近保存的 demo mint，其他演示 mint 可重新加载。

本地仅保存公开 mint 地址和已有待确认付款记录。创建交易不保存私钥、签名权限或原始签名交易；通过确定性 mint 地址恢复创建结果。App 显示“submitted”不等于链上成功；余额查询必须成功读取并验证 mint 后才显示余额。

## 验证

- TypeScript：通过。
- 自动化测试：44 个通过，包括原有 USDC、签名、RPC、恢复测试。
- 新增覆盖：缩放与最小单位；错误 multiplier/权限/扩展拒绝；Token-2022 余额、租金、raw amount；收据和待确认记录；创建指令顺序、发行量、撤权、唯一钱包签名和交易大小；相同 mint 恢复；钱包换账户/篡改交易拒绝；未确认和错误 program 的 mint 提示。
- Android release APK：见下面构建记录。
- 本轮未操作设备钱包，未实际发行代币或发送资产；这些步骤仍需用户签名与验收。

## 构建与验收

在项目根目录：

```sh
npm run typecheck
npm test
JAVA_HOME=/Users/victor/Library/Java/JavaVirtualMachines/corretto-17.0.20/Contents/Home \
ANDROID_HOME=/Users/victor/Library/Android/sdk npm run apk:android
~/Library/Android/sdk/platform-tools/adb install --no-streaming -r apps/mobile/android/app/build/outputs/apk/release/app-release.apk
```

1. 在 Devnet 钱包 A 准备 SOL，连接 App。
2. 点击 **Create demo asset in wallet**，检查钱包请求并确认。创建会消耗 Devnet SOL 租金和手续费。
3. 等待链上确认，点击 **Refresh balance**，应显示 **1,000 AAPLx-DEMO**。如果超时，刷新或使用同一钱包重试创建；不要换钱包来“重试”。
4. 复制资产卡上的完整 mint 地址，在钱包 B 所在设备的 **Demo mint address** 输入框粘贴，点击 **Load demo asset**。B 未收款时可显示 0。
5. A 选择此 AAPLx-DEMO，输入 B 的钱包地址和 `1`，复核后在钱包确认。
6. 等待 **Paid ✓**；A 刷新后为 999，B 刷新后为 1（假设没有其他转账）。核对交易的 Token-2022 program、mint、收款 ATA 和 raw amount `500000`。
7. 验证 `0.000001` 被拒绝；拒签后不广播；待确认期间不能切换资产、创建新资产或重复付款。
8. 切回 USDC 验证余额与原有转账流程。

若钱包不支持该 Token-2022 交易，保留错误信息并换兼容 MWA 钱包；不要绕过钱包或用应用私钥代签。

## 下一里程碑

用户于 2026-10-03 明确收款/付款优先：下一阶段为基础收付款与 Payment Intent（沿用 Milestone 3 编号），先于红包实现。包括收款金额、默认 USDC 的代币选择、收款码/扫码、默认商家承担网络费的双钱包授权流程。红包仍需普通/拼手气两种模式，后续单独实现。本轮 M1 APK 尚不支持这些收付款新流程。

## 参考

[Solana Scaled UI Amount 官方文档](https://solana.com/docs/tokens/extensions/scaled-ui-amount)。官方通用转换存在浮点精度及可变时间系数问题；本演示通过链上验证不可变 ×2 配置，以 bigint 做精确转账单位换算，不声称支持任意 multiplier。

## Milestone 1 历史 APK 构建记录

当前 APK 输出路径已由 M3 覆盖，最新构建和设备步骤见 [Milestone 3](MILESTONE_3.md)。下面 SHA 为 M1 历史构建。

Android arm64-v8a release 测试 APK 构建通过（BUILD SUCCESSFUL）。

路径：`apps/mobile/android/app/build/outputs/apk/release/app-release.apk`。

SHA-256：`53efe0883d2bcf94270baa4fdf0bf8e41729ab2c73461662cdba4414acb07422`。

本轮未安装此 APK；链上创建与 A→B 转账仍待用户验收。构建时发现 React Native Gradle 解包缓存缺失原生库，重建该依赖缓存后恢复；无需业务代码绕过。
