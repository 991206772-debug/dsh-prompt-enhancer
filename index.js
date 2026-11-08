/**
 * dsh-prompt-enhancer — Host half.
 *
 * 提供同源 HTTP 路由 POST /prompt-enhancer/enhance：把输入框草稿交给当前默认模型，
 * 改写成更完整、可执行的提示词后原样返回；由客户端半（client.js）写回输入框。
 * 本文件不接触浏览器、不写任何人的 DOM、不落盘、不打印草稿内容或密钥。
 */
import { Buffer } from 'node:buffer';
import Schema from '@deepseek-ai/schemastery';

export const name = 'prompt-enhancer';
/** 硬依赖 llm：没有模型服务时宁可整个插件不激活，也不留下一个必然报错的按钮。 */
export const inject = ['llm'];

/* ───────────────────────────── 元提示词（Host 侧常量） ───────────────────────────── */

const META_PROMPT = [
  '你是提示词改写器：把用户给出的草稿改写成一条更完整、可直接执行的提示词。',
  '必须遵守以下规则：',
  '1. 只保留草稿的原意与目标，不得新增需求、功能、技术选型、数据或验收条文；草稿没有的信息不要编造。',
  '2. 补齐结构与可执行要素：目标、范围（涉及的模块/文件/接口）、约束、验收标准、交付形态。',
  '   草稿确实缺少且无法从上下文推断的要素，写成“待确认：……”留白，不要臆造具体值。',
  '3. 代码片段、文件路径、报错文本、命令行、变量名、接口名、URL、数字与单位必须逐字保留，不得翻译或改写。',
  '4. 删除寒暄、客套、情绪化表达与模糊词（如“尽量”“大概”“差不多”“搞一下”），必要时改写为可判定的表述。',
  '5. 不要执行任务本身，不要给出解决过程、方案建议或结果，不要解释你在做什么。',
  '6. 不要写“以下是重写后的提示词”“增强结果：”之类的前言或结语。',
  '7. 只输出重写后的提示词正文；不要用代码块包裹，不要输出标题以外的装饰。',
  '8. 输出语言与草稿保持一致：草稿是中文就输出中文，草稿是英文就输出英文。',
  '9. 长度受控：总长度不超过原草稿的 3 倍；草稿很短时可放宽到约 500 字，但不得注水凑长度。',
].join('\n');

/* ────────────────────────────────── 配置 ────────────────────────────────── */

const DEFAULTS = {
  provider: '',
  model: '',
  temperature: 0.3,
  maxTokens: 1200,
  timeoutMs: 60000,
  maxDraftChars: 8000,
  maxBodyBytes: 64 * 1024,
  metaPrompt: META_PROMPT,
};

function clampNumber(value, fallback, min, max, integer) {
  const number = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(number)) return fallback;
  const clamped = Math.min(max, Math.max(min, number));
  return integer ? Math.round(clamped) : clamped;
}

/** 把已校验的 config 补上不对外暴露的运行期默认值（maxBodyBytes 不进 schema）。 */
function withRuntimeDefaults(input) {
  const source = input !== null && typeof input === 'object' ? input : {};
  return {
    provider: typeof source.provider === 'string' ? source.provider.trim() : DEFAULTS.provider,
    model: typeof source.model === 'string' ? source.model.trim() : DEFAULTS.model,
    temperature: typeof source.temperature === 'number' ? source.temperature : DEFAULTS.temperature,
    maxTokens: typeof source.maxTokens === 'number' ? source.maxTokens : DEFAULTS.maxTokens,
    timeoutMs: typeof source.timeoutMs === 'number' ? source.timeoutMs : DEFAULTS.timeoutMs,
    maxDraftChars: typeof source.maxDraftChars === 'number' ? source.maxDraftChars : DEFAULTS.maxDraftChars,
    maxBodyBytes: clampNumber(source.maxBodyBytes, DEFAULTS.maxBodyBytes, 1024, 1024 * 1024, true),
    metaPrompt:
      typeof source.metaPrompt === 'string' && source.metaPrompt.trim().length > 0
        ? source.metaPrompt
        : META_PROMPT,
  };
}

/**
 * Config 走真实依赖：package.json 的 dependencies 声明 `@deepseek-ai/schemastery`，
 * 静态 import 让它在 link 安装的插件目录里也解析得到（此前用 await import + try/catch
 * 静默降级成鸭子类型，导致宿主无法投影 schema，inspect 报 unsupported）。
 * 导入失败现在是明确的模块解析错误，而不是悄悄退化成假 schema。
 */
export const Config = Schema.object({
  provider: Schema.string().default(''),
  model: Schema.string().default(''),
  temperature: Schema.number().min(0).max(2).default(DEFAULTS.temperature),
  maxTokens: Schema.number().step(1).min(64).max(8192).default(DEFAULTS.maxTokens),
  timeoutMs: Schema.number().step(1).min(1000).max(300000).default(DEFAULTS.timeoutMs),
  maxDraftChars: Schema.number().step(1).min(100).max(100000).default(DEFAULTS.maxDraftChars),
  metaPrompt: Schema.string().default(META_PROMPT),
});

/* ────────────────────────────────── 工具 ────────────────────────────────── */

const MAX_RESULT_CHARS = 20000;

function safeMessage(error) {
  const raw = error && typeof error.message === 'string' ? error.message : String(error ?? 'unknown error');
  // 不把任何看起来像密钥的串回给浏览器或日志。
  return raw
    .replace(/\b(?:sk|pk|api[_-]?key|token)[-_:=*\s"']*[A-Za-z0-9_-]{8,}/gi, '[redacted]')
    .replace(/\bBearer\s+[A-Za-z0-9._-]{8,}/gi, 'Bearer [redacted]')
    .slice(0, 500);
}

function jsonResponse(res, status, body, extraHeaders) {
  if (res.writableEnded || res.destroyed) return;
  try {
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      ...(extraHeaders || {}),
    });
    res.end(JSON.stringify(body));
  } catch {
    /* 连接已断：忽略 */
  }
}

function failure(code, message) {
  return { ok: false, error: { code, message } };
}

/** 读请求体，超过上限立即放弃并返回 { tooLarge: true }。 */
async function readBody(req, limit) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > limit) return { tooLarge: true, body: null };
    chunks.push(buffer);
  }
  return { tooLarge: false, body: Buffer.concat(chunks).toString('utf8') };
}

/** 判断草稿里是否已经有代码围栏（有就绝不替用户解包，D4）。 */
function hasFence(text) {
  return String(text ?? '').includes('```');
}

/**
 * 去掉模型偶尔加的整段代码围栏，以及一行“下面是重写后的提示词：”式前言。
 *
 * D4：只有「整段输出被单一代码块完整包裹，且内部不再含 ```」时才解包；
 * 草稿本身含 ``` 时一律不解包——否则会把用户要保留的 java 代码块外壳吃掉。
 */
function tidyPrompt(text, draftHasFence) {
  let output = String(text ?? '').replace(/\r\n/g, '\n').trim();
  if (!draftHasFence) {
    const fenced = /^```[A-Za-z0-9_-]*\n([\s\S]*?)\n```$/.exec(output);
    if (fenced && !fenced[1].includes('```')) output = fenced[1].trim();
  }
  const lines = output.split('\n');
  if (lines.length > 1) {
    const head = lines[0].trim();
    if (/^(?:#{1,6}\s*)?(?:以下|下面|这是)?[^。！？!?]{0,12}(?:重写|增强|优化|改写)(?:后|过的|之后的)?(?:的)?提示词(?:如下)?[:：]?$/u.test(head)) {
      output = lines.slice(1).join('\n').trim();
    }
  }
  return output;
}

/* ───────────────────────────── 长度预算（D5） ───────────────────────────── */

/** 输出字符上限：min(max(3×草稿, 500), maxResultChars)，短稿也留 500 字余量。 */
function budgetFor(draftChars, maxResultChars) {
  return Math.min(Math.max(3 * draftChars, 500), maxResultChars);
}

/**
 * 按句/行边界截断到 budget 内，绝不硬切半个句子。
 * 顺序：整段若已超预算 → 先按行聚合，再按句读切分；只有单句本身超预算时才退化到字符级。
 */
function truncateAtBoundary(text, budget) {
  const source = String(text ?? '');
  if (source.length <= budget) return { text: source, clipped: false };

  // 先按行保留，能装下多少行就装多少行。
  const lines = source.split('\n');
  let kept = '';
  let keptAnyLine = false;
  for (const line of lines) {
    const candidate = kept.length === 0 ? line : `${kept}\n${line}`;
    if (candidate.length > budget) break;
    kept = candidate;
    keptAnyLine = true;
  }
  if (keptAnyLine && kept.trim().length > 0) {
    return { text: kept.trimEnd(), clipped: true };
  }

  // 单行超预算：按句子边界（中英文句末标点）切。
  const sentences = source.split(/(?<=[。！？；.!?;])\s*/u).filter((part) => part.length > 0);
  let sentenceKept = '';
  for (const sentence of sentences) {
    const candidate = sentenceKept + sentence;
    if (candidate.length > budget) break;
    sentenceKept = candidate;
  }
  if (sentenceKept.trim().length > 0) {
    return { text: sentenceKept.trimEnd(), clipped: true };
  }

  // 连一个完整句子都放不下：字符级兜底，但仍回退到最近的标点处，避免切半个词。
  let slice = source.slice(0, budget);
  const lastPunct = Math.max(
    slice.lastIndexOf('。'),
    slice.lastIndexOf('！'),
    slice.lastIndexOf('？'),
    slice.lastIndexOf('.'),
    slice.lastIndexOf(';'),
    slice.lastIndexOf('，'),
    slice.lastIndexOf(','),
  );
  if (lastPunct > Math.floor(budget / 2)) slice = slice.slice(0, lastPunct + 1);
  return { text: slice.trimEnd(), clipped: true };
}

function getService(ctx, key) {
  try {
    if (ctx && typeof ctx.get === 'function') {
      const service = ctx.get(key);
      if (service !== undefined && service !== null) return service;
    }
  } catch {
    /* 继续用属性访问兜底 */
  }
  try {
    const service = ctx ? ctx[key] : undefined;
    return service === undefined ? null : service;
  } catch {
    return null;
  }
}

/** 默认模型优先，Config 兜底；都拿不到返回 null。 */
function resolveRoute(ctx, config) {
  try {
    const service = getService(ctx, 'agentDefaultModel');
    const selection = service && typeof service.currentSelection === 'function' ? service.currentSelection() : null;
    if (selection && typeof selection.provider === 'string' && selection.provider && typeof selection.model === 'string' && selection.model) {
      return { provider: selection.provider, model: selection.model, source: 'default-model' };
    }
  } catch {
    /* 读默认模型失败：走配置 */
  }
  if (config.provider && config.model) {
    return { provider: config.provider, model: config.model, source: 'config' };
  }
  return null;
}

/* ─────────────────────────────── 请求处理 ─────────────────────────────── */

function createHandler(ctx, config) {
  return async function enhanceHandler(req, res) {
    try {
      if (!req || !res) return;
      if (req.method !== 'POST') {
        jsonResponse(res, 405, failure('method-not-allowed', 'only POST is accepted'), { allow: 'POST' });
        return;
      }
      const contentType = String(req.headers?.['content-type'] ?? '').split(';')[0].trim().toLowerCase();
      if (contentType !== 'application/json') {
        jsonResponse(res, 415, failure('unsupported-media-type', 'content-type must be application/json'));
        return;
      }
      // 自定义头 + 同源校验：挡住其它站点/本机其它服务对本机端口的盲打。
      if (String(req.headers?.['x-dsh-prompt-enhancer'] ?? '') !== '1') {
        jsonResponse(res, 403, failure('missing-client-header', 'required header x-dsh-prompt-enhancer: 1 is absent'));
        return;
      }

      let read;
      try {
        read = await readBody(req, config.maxBodyBytes);
      } catch {
        jsonResponse(res, 400, failure('bad-request-body', 'request body could not be read'));
        return;
      }
      if (read.tooLarge) {
        jsonResponse(res, 413, failure('payload-too-large', `request body exceeds ${config.maxBodyBytes} bytes`));
        return;
      }

      let payload;
      try {
        payload = JSON.parse(read.body || '{}');
      } catch {
        jsonResponse(res, 400, failure('invalid-json', 'request body is not valid JSON'));
        return;
      }
      if (payload === null || typeof payload !== 'object') {
        jsonResponse(res, 400, failure('invalid-json', 'request body must be a JSON object'));
        return;
      }

      const draft = typeof payload.draft === 'string' ? payload.draft : '';
      if (draft.trim().length === 0) {
        jsonResponse(res, 400, failure('empty-draft', 'draft is empty'));
        return;
      }
      if (draft.length > config.maxDraftChars) {
        jsonResponse(res, 413, failure('draft-too-long', `draft exceeds ${config.maxDraftChars} characters`));
        return;
      }

      const route = resolveRoute(ctx, config);
      if (!route) {
        jsonResponse(
          res,
          503,
          failure('no-model-configured', 'no default model selection and no provider/model configured for this plugin'),
        );
        return;
      }

      const llm = getService(ctx, 'llm');
      if (!llm || typeof llm.stream !== 'function') {
        jsonResponse(res, 503, failure('llm-unavailable', 'llm service is not available'));
        return;
      }

      const controller = new AbortController();
      const timer = setTimeout(() => {
        try {
          controller.abort(new Error('timeout'));
        } catch {
          /* 忽略 */
        }
      }, config.timeoutMs);

      // D5 第一道防线：调模型前把预算写进 system，并把 maxTokens 收紧到预算量级
      // （中文约 1.5 字符/token，英文约 4 字符/token；取偏保守的 1.5）。
      const outputBudgetChars = budgetFor(draft.length, MAX_RESULT_CHARS);
      // 极短草稿要求「五个小节各至少一句」，这是结构下限而不是注水：短草稿只有
      // 十几字时，光靠预算上限会缩成 130~180 字，用户看不出补全的价值。
      // 因此同时给出字数下限（floor）与上限（budget），两端都是硬约束。
      const outputFloorChars = draft.length < 60 ? Math.min(260, outputBudgetChars) : 0;
      const structureFloor =
        outputFloorChars > 0
          ? `11. 原草稿很短：目标/范围/约束/验收标准/交付形态五个小节，每节至少 45 个字符、写满一句完整的话，`
            + `本次输出至少 ${outputFloorChars} 字符、至多 ${outputBudgetChars} 字符。`
            + `缺信息的小节写「待确认：……」并具体说明要确认哪几项；这是补全结构，不是注水，也不要复述规则。`
          : '';
      // D4：草稿本身带 ``` 代码块时，规则 7 的「不要用代码块包裹」只针对整体包装，
      // 绝不能顺手删掉用户草稿里的围栏。模型经常把这条读成「输出里不许出现 ```」，
      // 所以这里显式给出例外，并把围栏与代码内容一起列为逐字保留项。
      const draftHasFence = hasFence(draft);
      const fenceClause = draftHasFence
        ? '\n12. 原草稿包含 ``` 代码块：必须把这些代码块连同开头的 ```<语言名> 与结尾的 ``` 一并逐字保留在输出中，'
          + '位置与缩进不变，不得省略、合并或改写围栏标记。规则 7 的「不要用代码块包裹」只禁止把整段输出包进一个代码块，'
          + '不禁止保留草稿原有的代码块。'
        : '';
      const system = `${config.metaPrompt}\n10. 本次输出上限 ${outputBudgetChars} 字符（原草稿 ${draft.length} 字符），超出即不合格；宁可精简结构也不要超长。${structureFloor ? `\n${structureFloor}` : ''}${fenceClause}`;
      const budgetTokens = Math.max(64, Math.min(config.maxTokens, Math.ceil(outputBudgetChars / 1.5) + 32));

      let text = '';
      let finish = null;
      try {
        const stream = llm.stream({
          provider: route.provider,
          model: route.model,
          messages: [{ role: 'user', content: [{ type: 'text', text: draft }] }],
          system,
          temperature: config.temperature,
          maxTokens: budgetTokens,
          signal: controller.signal,
        });
        for await (const chunk of stream) {
          if (!chunk || typeof chunk !== 'object') continue;
          if (chunk.type === 'text-delta' && typeof chunk.text === 'string') {
            text += chunk.text;
          } else if (chunk.type === 'finish') {
            finish = chunk.reason ?? null;
          }
        }
      } finally {
        clearTimeout(timer);
      }

      if (controller.signal.aborted) {
        jsonResponse(res, 504, failure('timeout', `model call exceeded ${config.timeoutMs} ms`));
        return;
      }
      if (finish && (finish.kind === 'error' || finish.kind === 'aborted')) {
        const detail = finish.failure ?? {};
        jsonResponse(
          res,
          502,
          failure(
            String(detail.code ?? 'model-error'),
            safeMessage(detail.message ?? 'the model call failed'),
          ),
        );
        return;
      }
      if (finish && finish.kind === 'tool-calls') {
        jsonResponse(res, 502, failure('unexpected-tool-calls', 'the model returned tool calls instead of text'));
        return;
      }

      let prompt = tidyPrompt(text, draftHasFence);
      if (prompt.length === 0) {
        jsonResponse(res, 502, failure('empty-result', 'the model produced no text'));
        return;
      }

      // D5 第二道防线：预算是硬约束——后置截断按句/行边界，不硬切半句。
      const bounded = truncateAtBoundary(prompt, outputBudgetChars);
      prompt = bounded.text;
      let clipped = bounded.clipped;
      if (prompt.length > MAX_RESULT_CHARS) {
        prompt = prompt.slice(0, MAX_RESULT_CHARS);
        clipped = true;
      }
      if (prompt.length === 0) {
        jsonResponse(res, 502, failure('empty-result', 'the model produced no usable text'));
        return;
      }

      jsonResponse(res, 200, {
        ok: true,
        prompt,
        provider: route.provider,
        model: route.model,
        routeSource: route.source,
        stats: {
          draftChars: draft.length,
          promptChars: prompt.length,
          budgetChars: outputBudgetChars,
          clipped,
          clippedByBudget: bounded.clipped,
          truncatedByTokens: Boolean(finish && finish.kind === 'max-tokens'),
        },
      });
    } catch (error) {
      // 任何未捕获异常都转成 JSON，绝不冒泡成进程级 unhandledRejection。
      try {
        console.error(`[prompt-enhancer] enhance failed: ${safeMessage(error)}`);
      } catch {
        /* 忽略 */
      }
      jsonResponse(res, 500, failure('internal-error', safeMessage(error)));
    }
  };
}

/* ─────────────────────────────── 插件入口 ─────────────────────────────── */

export function apply(ctx, rawConfig) {
  const config = withRuntimeDefaults(rawConfig);
  const handler = createHandler(ctx, config);

  const route = {
    name: 'prompt-enhancer-enhance',
    kind: 'exact',
    path: '/prompt-enhancer/enhance',
    handler,
  };

  const registerRoute = (scope) => {
    try {
      const webServer = getService(scope, 'webServer');
      if (!webServer || typeof webServer.register !== 'function') return;
      scope.effect(() => webServer.register(route), 'prompt-enhancer: enhance route');
    } catch (error) {
      console.error(`[prompt-enhancer] route registration failed: ${safeMessage(error)}`);
    }
  };

  // webServer 只在 web profile 存在；注入形式与 modsearch 同源（等它出现再注册，
  // 且插件卸载时由 effect 收回路由）。
  if (typeof ctx.inject === 'function') {
    try {
      ctx.inject(['webServer'], registerRoute);
    } catch (error) {
      console.error(`[prompt-enhancer] webServer injection failed: ${safeMessage(error)}`);
    }
  }
}
