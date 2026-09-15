# HR 飞书 Bitable 真实 E2E 验收

## 结论

真实飞书 Bitable 闭环已通过验收：iclaw 可以完成候选人首次创建、幂等重复同步、阶段变更同步、聊天工具能力链路和失败路径记录。

## 验收环境

| 项目 | 值 |
| --- | --- |
| 验收日期 | 2026-09-09 |
| Feishu 渠道账号 | `bitable` |
| Bitable App Token | `R2Efb2HkVa6WTHsbKCBcFNeXnmc` |
| Bitable Table ID | `tblTjDAX3zwHVl2H` |
| 验收候选人 | 黄xx |
| 候选人 ID | `d6c13429-2643-438a-be6e-b78ac6154710` |
| Bitable Record ID | `recvuJv9T19DLM` |

## 测试连接

| 项目 | 结果 |
| --- | --- |
| 连接 | 通过 |
| 字段读取 | 通过 |
| 字段映射 | `候选人ID`、`候选人`、`岗位`、`阶段`、`评分`、`推荐结论`、`简历链接`、`来源`、`更新时间` 全部识别 |
| 字段类型问题 | 无 |

## 首次真实创建

| 项目 | 结果 |
| --- | --- |
| 同步动作 | 通过 |
| Bitable 记录 | `recvuJv9T19DLM` |
| 数据库同步状态 | `synced` |

## 幂等重复同步

| 项目 | 结果 |
| --- | --- |
| 重复同步 | 通过 |
| 新建记录 | 否 |
| Record ID | 保持 `recvuJv9T19DLM` |
| 同步尝试次数 | 未增加 |

## 阶段变更同步

| 项目 | 结果 |
| --- | --- |
| 旧阶段 | 待技术初筛 |
| 新阶段 | 一面 |
| Agent 审计动作 | `candidate_stage_updated` |
| 飞书同步 | 通过 |
| Bitable Record ID | 保持 `recvuJv9T19DLM` |

## Bitable 回读

通过 `records/search` 按候选人 ID 回读：

| 字段 | 回读值 |
| --- | --- |
| `候选人ID` | `d6c13429-2643-438a-be6e-b78ac6154710` |
| `候选人` | 黄xx |
| `岗位` | 移动端安全工程师 |
| `阶段` | 一面 |
| `评分` | `45` |
| `推荐结论` | 匹配等级：不匹配。 |
| `更新时间` | `2026年9月9日 22:21:18` |

## 聊天能力链路

阶段变更使用了与 `hr_capability` / `hr_update_candidate` 相同的
`executeHrAgentCapability` 执行链路。该链路会：

1. 以 host 注入的 workspace owner 查询候选人；
2. 校验阶段枚举和确认标记；
3. 更新候选人阶段；
4. 写入 `candidate_stage_updated` 审计；
5. 复用飞书幂等同步。

因此本次真实写入同时验证了聊天工具的 host-side capability 后端路径。

## 失败路径

使用错误的 Table ID 做只读失败验证，返回：

```text
Feishu API 200: TableIdNotFound
```

错误被捕获并原样暴露为失败结果，未伪装成同步成功。早前的权限缺失场景也返回过
`Feishu API 403: Forbidden`，并保留在数据库同步错误状态中。
