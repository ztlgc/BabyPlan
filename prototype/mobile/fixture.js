// 由 tools/build_mobile_prototype.py 生成；仅含虚构演示数据。
window.BABYPLAN_FIXTURE = {
  "fixtureVersion": 1,
  "kind": "expanded-design-only",
  "dataClass": "fictional",
  "description": "全部人物、安排和文案均为虚构或原创演示，不代表API响应、正式内容、家庭实际情况或已确认交互。",
  "referenceNow": "2026-11-11T07:00:00Z",
  "timezone": "Asia/Shanghai",
  "businessDate": "2026-11-11",
  "networkPolicy": "local-simulation-only",
  "scopeStatus": "confirmed-goals-with-candidate-interactions",
  "family": {
    "id": "sample-family",
    "label": "虚构演示家庭",
    "members": [
      {
        "id": "sample-parent-a",
        "label": "家长甲（虚构）"
      },
      {
        "id": "sample-parent-b",
        "label": "家长乙（虚构）"
      }
    ]
  },
  "child": {
    "id": "sample-child",
    "ageBand": "18～23月",
    "birthDate": null
  },
  "books": [
    {
      "id": "sample-family-book",
      "label": "家中熟悉绘本（占位）",
      "editionStatus": "unverified",
      "cover": null,
      "readingPenCompatibility": "unknown"
    }
  ],
  "day": {
    "status": "candidate",
    "budgetMinutes": 60,
    "budgetNote": "纯亲子互动候选预算；可拆分、缩短或跳过，不要求凑满。",
    "segments": [
      {
        "id": "afternoon",
        "label": "晚饭前",
        "window": "16:00～17:15内弹性开展",
        "budgetMinutes": 25
      },
      {
        "id": "after_dinner",
        "label": "晚饭后",
        "window": "18:30～19:20内弹性开展",
        "budgetMinutes": 25
      },
      {
        "id": "bedtime",
        "label": "睡前",
        "window": "并入原有睡前流程；准确时间待确认",
        "budgetMinutes": 10
      }
    ],
    "items": [
      {
        "id": "sample-roll",
        "segmentId": "afternoon",
        "kind": "movement",
        "title": "把大软球滚给你",
        "budgetMinutes": 15,
        "materials": [
          "完整、适龄的大软球"
        ],
        "steps": [
          "清空平坦地面，成人和孩子近距离坐下。",
          "成人轻轻滚出球，停下来等回应。",
          "孩子愿意时再来一次；想走开就收好球。"
        ],
        "dialogue": {
          "opening": "球来找你啦。",
          "whenJoins": "你把球送回来了。",
          "whenWatches": "你在看球，我慢慢滚一次。",
          "whenStops": "好，我们先把球放好。"
        },
        "safety": "成人在旁近距离陪伴，检查球无松脱小零件；不追逐到台阶或障碍旁。",
        "participation": null,
        "sources": [
          {
            "kind": "design_sample",
            "title": "原创虚构流程样本（尚未正式内容审阅）"
          }
        ]
      },
      {
        "id": "sample-basket",
        "segmentId": "afternoon",
        "kind": "exploration",
        "title": "毛巾进篮子",
        "budgetMinutes": 10,
        "materials": [
          "完整大方巾",
          "稳定、无锐边的篮子"
        ],
        "steps": [
          "把篮子放在孩子身边。",
          "成人示范放入、取出方巾，再等孩子尝试。",
          "让孩子决定再放一次还是结束。"
        ],
        "dialogue": {
          "opening": "毛巾放进去了。",
          "whenJoins": "你把它拿出来啦。",
          "whenWatches": "我再慢慢放一次。",
          "whenStops": "我们把毛巾收好。"
        },
        "safety": "不将布盖在孩子头脸上；不使用带长绳、抽绳或小装饰的材料。",
        "participation": null,
        "sources": [
          {
            "kind": "design_sample",
            "title": "原创虚构流程样本（尚未正式内容审阅）"
          }
        ]
      },
      {
        "id": "sample-read-zh",
        "segmentId": "after_dinner",
        "kind": "reading",
        "title": "选一页，一起看看",
        "budgetMinutes": 10,
        "materials": [
          "家里一本已确认适合的熟悉绘本"
        ],
        "bookId": "sample-family-book",
        "language": "zh",
        "steps": [
          "让孩子从熟悉的书中选一本。",
          "停在孩子想看的页面，描述眼前一个动作。",
          "等待看、指或发声，接着回应；不要求读完整本。"
        ],
        "dialogue": {
          "opening": "你想看这一页呀。",
          "whenJoins": "你指到它了，我们再看看。",
          "whenWatches": "我和你一起看。",
          "whenStops": "今天先看到这里。"
        },
        "safety": "成人陪同翻页；破损机关或松脱部件先收起。",
        "participation": null,
        "sources": [
          {
            "kind": "design_sample",
            "title": "原创虚构流程样本（尚未正式内容审阅）"
          }
        ]
      },
      {
        "id": "sample-read-en",
        "segmentId": "after_dinner",
        "kind": "english",
        "title": "小熊在哪里",
        "budgetMinutes": 10,
        "materials": [
          "完整适龄的大玩偶"
        ],
        "language": "en",
        "steps": [
          "把玩偶放在孩子看得到的位置。",
          "说一句原创英文，配合指向和等待。",
          "孩子看、指或拿起都可回应；需要时用中文解释。"
        ],
        "dialogue": {
          "opening": "我们看看小熊在哪里。",
          "whenJoins": "你找到小熊啦。",
          "whenWatches": "我指给你看，小熊在这里。",
          "whenStops": "小熊先休息啦。"
        },
        "english": [
          {
            "line": "Where's the bear?",
            "meaningZh": "小熊在哪里？",
            "when": "玩偶可见时邀请共同寻找",
            "action": "看向或指向玩偶，等待回应"
          },
          {
            "line": "All done.",
            "meaningZh": "好啦，结束了。",
            "when": "孩子表示想停时",
            "action": "一起把玩偶放好"
          }
        ],
        "safety": "不遮住孩子面部，不要求跟读或测试；玩偶无松脱小零件。",
        "participation": null,
        "sources": [
          {
            "kind": "design_sample",
            "title": "原创虚构流程样本（尚未正式内容审阅）"
          }
        ]
      },
      {
        "id": "sample-child-led-a",
        "segmentId": "after_dinner",
        "kind": "child_led",
        "title": "你来选，我跟着玩",
        "budgetMinutes": 5,
        "materials": [],
        "steps": [
          "在安全空间里观察孩子想做什么。",
          "跟随孩子的动作，用一句话回应。",
          "愿意时轮流，不强行加入。"
        ],
        "dialogue": {
          "opening": "你想玩这个呀。",
          "whenJoins": "我跟你一起。",
          "whenWatches": "我在这里陪你。",
          "whenStops": "好，我们歇一歇。"
        },
        "safety": "只跟随安全、适龄的玩法；不将等待理解成必须完成任务。",
        "participation": null,
        "sources": [
          {
            "kind": "design_sample",
            "title": "原创虚构流程样本（尚未正式内容审阅）"
          }
        ]
      },
      {
        "id": "sample-child-led-b",
        "segmentId": "bedtime",
        "kind": "child_led",
        "title": "还想看哪一页",
        "budgetMinutes": 5,
        "materials": [
          "熟悉绘本"
        ],
        "steps": [
          "邀请孩子选一页熟悉的图。",
          "安静地共看，跟随孩子的指向。",
          "想睡时马上结束。"
        ],
        "dialogue": {
          "opening": "你还想看看哪一页？",
          "whenJoins": "我们再看看这里。",
          "whenWatches": "我陪你看一小会儿。",
          "whenStops": "好，我们准备休息。"
        },
        "safety": "并入原有睡前流程，不因预算延迟睡眠。",
        "participation": null,
        "sources": [
          {
            "kind": "design_sample",
            "title": "原创虚构流程样本（尚未正式内容审阅）"
          }
        ]
      },
      {
        "id": "sample-replay",
        "segmentId": "bedtime",
        "kind": "replay",
        "title": "跟小熊说晚安",
        "budgetMinutes": 5,
        "materials": [
          "完整大玩偶"
        ],
        "steps": [
          "成人示范轻轻挥手。",
          "接受孩子用动作、声音或观看回应。",
          "说晚安后收好玩偶，结束互动。"
        ],
        "dialogue": {
          "opening": "小熊要休息啦。",
          "whenJoins": "你在跟它道别。",
          "whenWatches": "我挥挥手，晚安。",
          "whenStops": "好，我们也休息。"
        },
        "safety": "不把玩偶留作婴幼儿睡眠环境安全的承诺；遵循家庭和专业人员的安全建议。",
        "participation": null,
        "sources": [
          {
            "kind": "design_sample",
            "title": "原创虚构流程样本（尚未正式内容审阅）"
          }
        ]
      }
    ]
  },
  "participationDraft": {
    "itemId": "sample-roll",
    "status": "played",
    "participantIds": [
      "sample-parent-a"
    ],
    "addedBy": "sample-parent-b",
    "feedback": null,
    "persistence": "simulation-only"
  },
  "memoryDraft": {
    "text": "今天把球轻轻推回来，抬头看着我。（原创虚构故事）",
    "firstTimeConfirmed": false,
    "media": {
      "placeholder": true,
      "state": "pending_upload",
      "remoteVisible": false
    }
  },
  "measurementDraft": {
    "date": "2026-11-11",
    "kind": "length_height",
    "value": null,
    "unit": "cm",
    "method": null,
    "measurementSource": null,
    "referenceStandard": null,
    "percentile": null
  },
  "replacementSample": {
    "targetItemId": "sample-roll",
    "candidate": {
      "id": "sample-walk",
      "segmentId": "afternoon",
      "kind": "movement",
      "title": "跟着脚步慢慢走",
      "budgetMinutes": 15,
      "materials": [],
      "steps": [
        "清空平坦地面，成人慢慢走两步。",
        "停下等孩子看或跟来，愿意时换孩子带路。",
        "孩子想停时一起坐下休息。"
      ],
      "dialogue": {
        "opening": "我慢慢走两步。",
        "whenJoins": "我跟着你走。",
        "whenWatches": "你在这里看也可以。",
        "whenStops": "好，先休息。"
      },
      "safety": "成人在旁，远离台阶与障碍；不拉拽孩子追赶。",
      "sources": [
        {
          "kind": "design_sample",
          "title": "原创虚构替换候选（尚未正式内容审阅）"
        }
      ],
      "participation": null
    },
    "shortenCandidateMinutes": 5,
    "confirmed": false,
    "mechanismStatus": "candidate"
  },
  "conflictSample": {
    "itemId": "sample-roll",
    "local": {
      "status": "played",
      "participantIds": [
        "sample-parent-a"
      ],
      "addedBy": "sample-parent-b"
    },
    "remote": {
      "status": "skipped",
      "feedback": "child_tired",
      "participantIds": [
        "sample-parent-b"
      ],
      "addedBy": "sample-parent-b"
    },
    "resolved": false,
    "mechanismStatus": "candidate"
  },
  "stageGuideSample": {
    "status": "design_sample_pending_content_review",
    "ageBand": "18～23月（产品编排区间）",
    "focus": "一起看图、等待和轮流",
    "everydayExample": "孩子指向书页，成人跟随指向描述眼前内容。",
    "parentSupport": "回应看、指或发声，不连续提问，不要求读完整本。",
    "playIdeas": [
      "选一页熟悉绘本一起看",
      "用图中主题和实物玩简单找物"
    ],
    "easierVersion": "成人先描述一个动作，孩子只看也可以。",
    "optionalNextStep": "孩子愿意时，等待孩子先选页面或物品。",
    "source": {
      "title": "CDC18月家庭活动建议（依据研究笔记；此处为产品转译）",
      "url": "https://www.cdc.gov/act-early/milestones/18-months.html",
      "boundary": "18月节点不是18～23月逐月标准；此示例不是完整阶段清单或发育筛查。"
    }
  },
  "contentWorkflow": {
    "roles": [
      "demo_editor",
      "demo_reviewer",
      "demo_publisher",
      "demo_viewer"
    ],
    "roleRulesStatus": "candidate",
    "draftItemId": "sample-roll",
    "publishedVersion": 1,
    "draftVersion": 2,
    "states": [
      "draft",
      "in_review",
      "changes_requested",
      "ready",
      "publishing",
      "published",
      "failed",
      "withdrawal_confirmation"
    ],
    "operations": "simulation-only",
    "permissions": {
      "demo_editor": [
        "edit_draft",
        "submit_review"
      ],
      "demo_reviewer": [
        "review",
        "request_changes"
      ],
      "demo_publisher": [
        "publish",
        "withdraw"
      ],
      "demo_viewer": []
    },
    "draftContent": {
      "id": "sample-roll",
      "segmentId": "afternoon",
      "kind": "movement",
      "title": "滚球慢慢来（草稿演示）",
      "budgetMinutes": 15,
      "materials": [
        "完整、适龄的大软球"
      ],
      "steps": [
        "清空平坦地面，成人和孩子近距离坐下。",
        "成人轻轻滚出球，停下来等回应。",
        "孩子愿意时再来一次；想走开就收好球。"
      ],
      "dialogue": {
        "opening": "球来找你啦。",
        "whenJoins": "你把球送回来了。",
        "whenWatches": "你在看球，我慢慢滚一次。",
        "whenStops": "好，我们先把球放好。"
      },
      "safety": "成人在旁近距离陪伴，检查球无松脱小零件；不追逐到台阶或障碍旁。",
      "participation": null,
      "sources": [
        {
          "kind": "design_sample",
          "title": "原创虚构流程样本（尚未正式内容审阅）"
        }
      ]
    },
    "reviewReason": "演示：补充滚球空间检查，并说明不要求孩子接球。",
    "failureReason": "演示：发布暂不可用，请稍后重试。",
    "withdrawalImpact": {
      "affectedItemIds": [
        "sample-roll"
      ],
      "history": "保留原快照",
      "startedOrAdjusted": "不自动改写",
      "unstarted": "处理方式待确认；本原型仅展示影响提示"
    }
  },
  "scenarios": [
    {
      "id": "expanded_today",
      "surface": "今天",
      "expected": "准备好的三段安排；预算非倒计时，任一项可缩短或跳过。",
      "simulationOnly": true,
      "overrides": {}
    },
    {
      "id": "expanded_loading",
      "surface": "今天",
      "expected": "正在读取今天安排；加载不能显示为无内容。",
      "simulationOnly": true,
      "overrides": {
        "requestState": "loading"
      }
    },
    {
      "id": "expanded_service_error",
      "surface": "今天",
      "expected": "服务暂不可用；保留已有内容与重试入口。",
      "simulationOnly": true,
      "overrides": {
        "requestState": "failed",
        "failureReason": "演示：服务暂不可用"
      }
    },
    {
      "id": "expanded_connection_expired",
      "surface": "连接恢复",
      "expected": "连接已失效；本机资料保留，不展示凭证输入示例。",
      "simulationOnly": true,
      "overrides": {
        "connectionState": "expired"
      }
    },
    {
      "id": "expanded_empty",
      "surface": "今天",
      "expected": "暂无可用安排，可重试和查看书架；不自动编造已发布内容。",
      "simulationOnly": true,
      "overrides": {
        "daySource": null
      }
    },
    {
      "id": "expanded_participation",
      "surface": "记录",
      "expected": "陪伴者家长甲，添加者家长乙，保存后返回今天；取消不修改。",
      "simulationOnly": true,
      "overrides": {
        "activeDraft": "#/participationDraft"
      }
    },
    {
      "id": "expanded_other_member",
      "surface": "今天",
      "expected": "模拟切换家长后读取同一条家庭记录，不新增重复条目。",
      "simulationOnly": true,
      "overrides": {
        "activeMemberId": "sample-parent-a",
        "itemRecords": {
          "sample-roll": {
            "itemId": "sample-roll",
            "date": "2026-11-11",
            "status": "played",
            "participantIds": [
              "sample-parent-a"
            ],
            "addedBy": "sample-parent-b",
            "feedback": null,
            "simulationOnly": true
          }
        },
        "syncStates": {
          "sample-roll": "synced"
        }
      }
    },
    {
      "id": "expanded_future",
      "surface": "未来安排",
      "expected": "未来内容可查看，不可提前记录已经参与。",
      "simulationOnly": true,
      "overrides": {
        "daySource": "#/futureDaySample",
        "selectedItemId": "future-sample-roll"
      }
    },
    {
      "id": "expanded_offline_cached",
      "surface": "今天",
      "expected": "看已缓存内容，参与记录显示已存本机、待同步。",
      "simulationOnly": true,
      "overrides": {
        "network": "offline",
        "itemRecords": {
          "sample-roll": {
            "itemId": "sample-roll",
            "date": "2026-11-11",
            "status": "played",
            "participantIds": [
              "sample-parent-a"
            ],
            "addedBy": "sample-parent-b",
            "feedback": null,
            "simulationOnly": true
          }
        },
        "syncStates": {
          "sample-roll": "pending"
        }
      }
    },
    {
      "id": "expanded_offline_empty",
      "surface": "今天",
      "expected": "没有下载内容，提示联网；不能离线假装自动排好新一天。",
      "simulationOnly": true,
      "overrides": {
        "network": "offline",
        "daySource": null
      }
    },
    {
      "id": "expanded_sync_sending",
      "surface": "同步恢复",
      "expected": "发送中保留更晚本机意图；禁止旧响应覆盖新编辑。",
      "simulationOnly": true,
      "overrides": {
        "itemRecords": {
          "sample-roll": {
            "itemId": "sample-roll",
            "date": "2026-11-11",
            "status": "played",
            "participantIds": [
              "sample-parent-a"
            ],
            "addedBy": "sample-parent-b",
            "feedback": null,
            "simulationOnly": true
          }
        },
        "syncStates": {
          "sample-roll": "sending"
        }
      }
    },
    {
      "id": "expanded_sync_failed",
      "surface": "同步恢复",
      "expected": "失败可重试，保留内容和修改；不声称已同步。",
      "simulationOnly": true,
      "overrides": {
        "itemRecords": {
          "sample-roll": {
            "itemId": "sample-roll",
            "date": "2026-11-11",
            "status": "played",
            "participantIds": [
              "sample-parent-a"
            ],
            "addedBy": "sample-parent-b",
            "feedback": null,
            "simulationOnly": true
          }
        },
        "syncStates": {
          "sample-roll": "failed"
        },
        "failureReason": "演示：同步未成功，选择已保存在本机"
      }
    },
    {
      "id": "expanded_sync_success",
      "surface": "同步恢复",
      "expected": "模拟收到对应操作确认才标已同步，原型不发送请求。",
      "simulationOnly": true,
      "overrides": {
        "itemRecords": {
          "sample-roll": {
            "itemId": "sample-roll",
            "date": "2026-11-11",
            "status": "played",
            "participantIds": [
              "sample-parent-a"
            ],
            "addedBy": "sample-parent-b",
            "feedback": null,
            "simulationOnly": true
          }
        },
        "syncStates": {
          "sample-roll": "synced"
        }
      }
    },
    {
      "id": "expanded_conflict",
      "surface": "同步恢复",
      "expected": "本机与另一家长的版本并排，明确采用哪版；可稍后处理。",
      "simulationOnly": true,
      "overrides": {
        "activeDraft": "#/conflictSample",
        "syncStates": {
          "sample-roll": "conflict"
        }
      }
    },
    {
      "id": "expanded_replace",
      "surface": "换活动",
      "expected": "同段换为候选内容，确认后才改；已开展项不自动重排。",
      "simulationOnly": true,
      "overrides": {
        "activeDraft": "#/replacementSample"
      }
    },
    {
      "id": "expanded_book_unverified",
      "surface": "书架",
      "expected": "版本未确认，只展示系列文字，不出现页码、封面或点读承诺。",
      "simulationOnly": true,
      "overrides": {
        "activeDraft": "#/books/0"
      }
    },
    {
      "id": "expanded_stage",
      "surface": "阶段指引",
      "expected": "关注方向和支持玩法，区间为产品编排；不打分。",
      "simulationOnly": true,
      "overrides": {
        "activeDraft": "#/stageGuideSample"
      }
    },
    {
      "id": "expanded_memory_empty",
      "surface": "成长",
      "expected": "尚无成长记录，可添加故事或原话；不推断第一次。",
      "simulationOnly": true,
      "overrides": {
        "memoryRecords": [],
        "activeDraft": null
      }
    },
    {
      "id": "expanded_media_pending",
      "surface": "成长",
      "expected": "照片占位已存本机待上传，不冒充远端可见。",
      "simulationOnly": true,
      "overrides": {
        "memoryRecords": [
          {
            "text": "今天把球轻轻推回来，抬头看着我。（原创虚构故事）",
            "firstTimeConfirmed": false,
            "media": {
              "placeholder": true,
              "state": "pending_upload",
              "remoteVisible": false
            },
            "simulationOnly": true
          }
        ],
        "activeDraft": "#/memoryDraft"
      }
    },
    {
      "id": "expanded_media_failure",
      "surface": "成长",
      "expected": "上传失败可重试；文字可保留，其他设备不可见未上传照片。",
      "simulationOnly": true,
      "overrides": {
        "memoryRecords": [
          {
            "text": "今天把球轻轻推回来，抬头看着我。（原创虚构故事）",
            "firstTimeConfirmed": false,
            "media": {
              "placeholder": true,
              "state": "failed",
              "remoteVisible": false
            },
            "simulationOnly": true
          }
        ],
        "failureReason": "演示：照片未上传成功，文字已保留"
      }
    },
    {
      "id": "expanded_media_denied",
      "surface": "成长",
      "expected": "相册权限关闭仍可写故事；仅用户点添加照片后提示权限。",
      "simulationOnly": true,
      "overrides": {
        "photoPermission": "denied",
        "activeDraft": "#/textOnlyMemoryDraft",
        "memoryRecords": []
      }
    },
    {
      "id": "expanded_measurement",
      "surface": "测量",
      "expected": "录入日期/单位/方式；无参考资料只列家庭记录，不给百分位。",
      "simulationOnly": true,
      "overrides": {
        "activeDraft": "#/measurementDraft"
      }
    },
    {
      "id": "expanded_reminder_denied",
      "surface": "设置",
      "expected": "提醒偏好与系统权限分开；拒绝不阻断使用。",
      "simulationOnly": true,
      "overrides": {
        "reminder": {
          "enabled": true,
          "time": "16:00",
          "permission": "denied",
          "status": "candidate"
        }
      }
    },
    {
      "id": "expanded_reminder_elapsed",
      "surface": "设置",
      "expected": "今天提醒时间已过，不补发；每日仅一条为候选规则。",
      "simulationOnly": true,
      "overrides": {
        "referenceNow": "2026-11-11T12:00:00Z",
        "reminder": {
          "enabled": true,
          "time": "16:00",
          "permission": "granted",
          "status": "candidate"
        }
      }
    },
    {
      "id": "expanded_parent_web",
      "surface": "家长网页",
      "expected": "与安卓共用家庭安排，查看阶段路线、整理书目和成长，不出现发布权限。",
      "simulationOnly": true,
      "overrides": {
        "activeDraft": "#/stageGuideSample"
      }
    },
    {
      "id": "expanded_print",
      "surface": "家长网页",
      "expected": "打印预览使用已选内容；默认不包含照片或整份成长档案。",
      "simulationOnly": true,
      "overrides": {
        "printSelection": [
          "sample-roll"
        ],
        "includeMedia": false
      }
    },
    {
      "id": "expanded_admin_draft",
      "surface": "内容管理",
      "expected": "虚构编辑修改草稿；家长安排仍显示原已发布内容。",
      "simulationOnly": true,
      "overrides": {
        "adminRole": "demo_editor",
        "workflowState": "draft",
        "activeDraft": "#/contentWorkflow/draftContent"
      }
    },
    {
      "id": "expanded_admin_review",
      "surface": "内容管理",
      "expected": "送审后展示核验与来源，待修改原因明确；权限规则为候选。",
      "simulationOnly": true,
      "overrides": {
        "adminRole": "demo_reviewer",
        "workflowState": "changes_requested",
        "activeDraft": "#/contentWorkflow/draftContent"
      }
    },
    {
      "id": "expanded_admin_forbidden",
      "surface": "内容管理",
      "expected": "无发布权限显示原因，不允许模拟越权成功。",
      "simulationOnly": true,
      "overrides": {
        "adminRole": "demo_viewer",
        "workflowState": "ready"
      }
    },
    {
      "id": "expanded_publish_failed",
      "surface": "内容管理",
      "expected": "模拟发布失败，原活跃版本保持，草稿可恢复。",
      "simulationOnly": true,
      "overrides": {
        "adminRole": "demo_publisher",
        "workflowState": "failed",
        "failureReason": "演示：发布暂不可用，请稍后重试。",
        "visiblePublishedVersion": 1
      }
    },
    {
      "id": "expanded_publish_success",
      "surface": "内容管理",
      "expected": "明确模拟发布成功；不改历史与已开展、家长已调整的项。",
      "simulationOnly": true,
      "overrides": {
        "adminRole": "demo_publisher",
        "workflowState": "published",
        "visiblePublishedVersion": 2
      }
    },
    {
      "id": "expanded_withdraw",
      "surface": "内容管理",
      "expected": "确认前说明影响范围；对未开展项的自动处理规则仍待确认。",
      "simulationOnly": true,
      "overrides": {
        "adminRole": "demo_publisher",
        "workflowState": "withdrawal_confirmation",
        "activeDraft": "#/contentWorkflow/withdrawalImpact"
      }
    }
  ],
  "scenarioInstructions": "每次复制initialState，用场景overrides逐个顶层键替换（嵌套对象整块替换），按daySource选择内容。所有#/引用均为本文件JSON Pointer；草稿只在activeDraft指定时展示。切换场景必须重置，不能继承上一场景的状态。",
  "initialState": {
    "referenceNow": "2026-11-11T07:00:00Z",
    "activeMemberId": "sample-parent-a",
    "network": "online",
    "requestState": "ready",
    "connectionState": "connected",
    "daySource": "#/day",
    "selectedItemId": "sample-roll",
    "activeDraft": null,
    "itemRecords": {},
    "syncStates": {},
    "memoryRecords": [],
    "photoPermission": "granted",
    "reminder": {
      "enabled": true,
      "time": "16:00",
      "permission": "granted",
      "status": "candidate"
    },
    "adminRole": "demo_editor",
    "workflowState": "draft",
    "failureReason": null,
    "printSelection": [],
    "includeMedia": false,
    "visiblePublishedVersion": 1
  },
  "futureDaySample": {
    "date": "2026-11-12",
    "status": "candidate_readonly_preview",
    "note": "只有一个未来内容块用于只读演示，不是已生成的完整明日计划",
    "items": [
      {
        "id": "future-sample-roll",
        "segmentId": "afternoon",
        "kind": "movement",
        "title": "把大软球滚给你",
        "budgetMinutes": 15,
        "materials": [
          "完整、适龄的大软球"
        ],
        "steps": [
          "清空平坦地面，成人和孩子近距离坐下。",
          "成人轻轻滚出球，停下来等回应。",
          "孩子愿意时再来一次；想走开就收好球。"
        ],
        "dialogue": {
          "opening": "球来找你啦。",
          "whenJoins": "你把球送回来了。",
          "whenWatches": "你在看球，我慢慢滚一次。",
          "whenStops": "好，我们先把球放好。"
        },
        "safety": "成人在旁近距离陪伴，检查球无松脱小零件；不追逐到台阶或障碍旁。",
        "participation": null,
        "sources": [
          {
            "kind": "design_sample",
            "title": "原创虚构流程样本（尚未正式内容审阅）"
          }
        ]
      }
    ]
  },
  "savedRecordSample": {
    "itemId": "sample-roll",
    "date": "2026-11-11",
    "status": "played",
    "participantIds": [
      "sample-parent-a"
    ],
    "addedBy": "sample-parent-b",
    "feedback": null,
    "simulationOnly": true
  },
  "textOnlyMemoryDraft": {
    "text": "今天把球轻轻推回来，抬头看着我。（原创虚构故事）",
    "firstTimeConfirmed": false,
    "media": null
  }
};
