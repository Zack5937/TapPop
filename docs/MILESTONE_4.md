# Milestone 4 — AAPLx-DEMO → USDC 原子演示结算

2026-10-03 用户要求继续开发，按既定次序实现 M4。代码与自动化验证完成；M0 转账、M1 铸币/转账、M3 双设备付款以及本阶段真实链上付款仍待用户设备验收。本轮未安装 APK、未操作用户钱包或广播真实交易。

## 实现范围

新增 **Pay with demo stock** 入口：商家请求 5 USDC，客户以 0.025 AAPLx-DEMO 支付，独立演示流动性钱包向商家支付 5 Devnet USDC。客户、商家和流动性钱包通过 MWA 分别确认同一交易。

- `DemoQuoteProvider` 固定演示价格：1 个显示单位 AAPLx-DEMO = 200 USDC，不是市场行情。
- M1 Token-2022 不可变 ×2 profile：0.025 显示单位 = 12,500 raw units。金额全程用整数；不能精确兑换的金额直接拒绝，不隐藏舍入。可结算 USDC 金额须是 0.0004 的整数倍。
- 单个交易包含：创建流动性钱包的股票 ATA、客户 → 流动性钱包的 AAPLx-DEMO 转账、创建商家 USDC ATA、流动性钱包 → 商家的 USDC 转账，以及绑定请求的 memo/reference。
- 默认商家支付网络费和两个新收款 ATA 的租金；客户显示 0 SOL gas。费用与租金分别展示，网络费上限 0.00002 SOL，没有额外转换费或服务费。
- 三个钱包地址必须不同。流动性钱包由商家输入公开地址，不保存任何私钥、不自动取得储备金权限。流动性方逐笔确认实际付出 USDC 的交易。
- 无需部署合约或支付服务器；采用原生 SPL / Token-2022 指令和多方签名。Solana 将同一交易中的指令原子执行，任何指令失败则资产变更一起回滚，失败仍可能收取网络费。[Solana Transactions](https://solana.com/docs/core/transactions)
- 请求与授权支持专用二维码/深链 `tappay://settle`。较大的交易交接分成多张二维码，扫描端收齐后验证；也支持复制完整文本。分片 ID 仅用于组装，不作为授权，所有签名都覆盖相同完整 message。[Solana Partial Signing](https://solana.com/docs/core/transactions/partial-signing)

## 资金与恢复约束

每次签名前验证 Devnet genesis、USDC mint、Token-2022 profile、双方资金余额、冻结状态、费用、租金和 blockhash。收到交易后按请求重建，并逐字节比较 message，拒绝改金额、换地址、换 mint、改变费用方或额外指令。

客户签名后先保存再展示交接码；商家和流动性方每次追加签名后同样保存。最终广播前再次保存完整签名交易；存储失败不能广播。超时后保留相同交易，不改 blockhash 重付。合并只能添加同一 message 的有效签名，不能丢掉已有签名。

链上确认比较整笔交易 message 和签名，而非只查 USDC 增加或单条 transfer：两个资产转移、金额、authority、fee payer、reference、memo 全部要匹配。仅 confirmed/finalized 收据可显示 Paid。

未决授权重启后恢复，持续查原 reference。仅在 finalized 高度超过期限、blockhash 确认失效且重新查询完整历史未找到交易时允许结束。历史缺失、RPC 故障或超过 3 页 × 100 条扫描上限时保持阻止重付。

普通 SPL 交易没有全局已消费 nonce 的合约。准备付款和补签会查是否已支付，但不能保证恶意/并发客户端不重复支付同一请求；客户端期限也不能在链上强制终止已签交易。

## 自动化验证

```sh
npm run typecheck
npm test
```

类型检查与 69 项测试通过（60 项既有测试 + 9 项 M4 测试）。新增覆盖精确固定汇率、Scaled UI Amount、两条转账及三方权限、流动性不足、冻结/费用不足、篡改指令与报价绑定、签名合并、分片乱序/重复/混入、存储失败、广播超时、完整收据验证以及过期恢复。

测试使用临时未注资签名者与模拟 RPC，不代表真实 Devnet 付款已经验收。本轮无新增依赖，沿用 M3 依赖及其已记录审计告警。

## M4 历史构建产物

下列校验值记录 M4 当时构建；当前 APK 已更新为 M5，最新产物见 [M5](MILESTONE_5.md)。

Android arm64 release 构建成功，未安装。

- APK：`apps/mobile/android/app/build/outputs/apk/release/app-release.apk`
- 大小：34,856,170 bytes
- SHA-256：`7e5e372c295c90acd8a30b834fa60f4bad93a36eeefcdd2fa1d3b7d7eff2d23a`

## 构建与设备步骤

```sh
JAVA_HOME=/Users/victor/Library/Java/JavaVirtualMachines/corretto-17.0.20/Contents/Home \
ANDROID_HOME=/Users/victor/Library/Android/sdk npm run apk:android
~/Library/Android/sdk/platform-tools/adb install --no-streaming -r apps/mobile/android/app/build/outputs/apk/release/app-release.apk
```

1. 准备三个独立 Devnet 钱包，建议三台设备：商家有 SOL；客户有 M1 创建的 AAPLx-DEMO（可无 SOL）；流动性钱包有至少 5 Devnet USDC。
2. 三台设备使用新版 APK 和支持 MWA 部分签名的钱包。先处理完既有未决付款；如果商家目前显示 M3 长期收款码，先 Close merchant QR，再使用 M4 入口。两个流程不能同时打开。
3. 商家加载客户所持的同一 demo mint。进入 **Pay with demo stock → Create stock-funded USDC request**，输入 5、流动性钱包公开地址，选择该 AAPLx-DEMO，点击 **Show demo settlement request**。
4. 客户使用 **Scan demo settlement QR** 扫商家码的全部分片（每扫一张重新打开扫描，商家点 Next part）；模拟器可复制完整文本并 Read demo settlement text。
5. 客户核对商家、流动性钱包、mint、5 USDC / 0.025 AAPLx-DEMO、固定演示价格和客户 0 SOL gas。点击 **Review AAPLx-DEMO payment → Confirm customer payment in wallet**。客户保存并显示授权码。
6. 商家仍在原请求内，扫码/粘贴客户授权。核对金额、费用和租金，点击 **Authorize merchant fees in wallet**。商家保存带两个签名的授权码。
7. 流动性钱包连接自己的账户，扫描商家的授权码。核对将付出 5 USDC、收到 0.025 AAPLx-DEMO，点击 **Authorize demo USDC liquidity in wallet**。三方签名齐全后保存并广播。
8. 三端 **Check settlement** 或等待自动查询，均应显示 Paid ✓；浏览器中验证同一签名包含两笔真实转账，商家 USDC 增加 5、客户 demo token 减少 12,500 raw units。
9. 若授权过期，所有已经签名的设备先查到 Authorization expired，再 Done 和新建请求；不能修改已签交易的 blockhash 继续使用。

异常路径：拒签不广播；流动性钱包 USDC 不足不能签；商家 SOL 不足不能签；任一方改交易应被拒绝；关闭重开 App 恢复未决授权；广播超时持续查原交易；确认失败不显示 Paid。

## 已知限制

- 这是三方钱包参与的固定价格 Devnet 演示流动性，不是自动兑换池、真实股票或官方 xStocks 集成。
- 当前用独立 M4 入口完成跨资产流程；M3 的长期商家码和普通指定金额收款码仍只执行同币种付款，尚未接入该演示流动性路由。不要将普通收款码上的不支持兑换选项伪装成已可付款。
- 分片多次扫描和三方钱包确认需在近期 blockhash 的有效窗口内完成。文本交接适合模拟器演示；真实扫描速度及钱包兼容性待验收。
- M4 请求最长 10 分钟，交易签名通常更早失效。长期有效的 M3 商家码保持不变。
- 未进行 Mainnet、实际钱包资金操作、生产授权服务或部署合约。

## 下一里程碑

M5：Android NFC 发现与传输，复用现有请求校验和钱包确认流程，优先静态标签/链接回退。需真实 NFC 设备验收；不同时启动红包或 NFT 开发。
