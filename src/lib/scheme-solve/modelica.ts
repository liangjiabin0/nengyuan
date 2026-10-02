import fs from 'node:fs';
import path from 'node:path';
import { schemeIdeaDirectory, writeWorkspaceText } from './workspace';

export const MODELICA_ENGINE = 'openmodelica';

export function resolveModelicaGatewayUrl() {
  return process.env.OPENMODELICA_GATEWAY_URL?.trim() || 'http://127.0.0.1:18088';
}

export function resolveModelicaApiKey() {
  return process.env.OMG_API_KEY?.trim() || 'change-me';
}

function asErrorRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

export function modelicaDirs(sessionId: string, ideaId: string) {
  const ideaDir = schemeIdeaDirectory(sessionId, ideaId);
  return {
    dir: path.join(ideaDir, 'modelica'),
    modelPath: path.join(ideaDir, 'modelica', 'model.mo'),
    resultPath: path.join(ideaDir, 'modelica', 'result.json')
  };
}

function token(value: number) {
  return String(value).replace('.', 'p');
}

export function inferBatteryParams(text?: string) {
  const value = String(text || '');
  const energy = Number(value.match(/(\d+(?:\.\d+)?)\s*kWh/i)?.[1] || 100);
  const soc = Number(value.match(/(?:初始\s*)?SOC\s*=\s*(\d+(?:\.\d+)?)/i)?.[1] || 0.8);
  const withoutEnergy = value.replace(/(\d+(?:\.\d+)?)\s*kWh/ig, ' ');
  const power = Number(withoutEnergy.match(/(\d+(?:\.\d+)?)\s*kW\b/i)?.[1] || 20);
  const hoursMatch = value.match(/(\d+(?:\.\d+)?)\s*小时/);
  const minutesMatch = value.match(/(\d+(?:\.\d+)?)\s*分钟/);
  const hours = hoursMatch ? Number(hoursMatch[1]) : minutesMatch ? Number(minutesMatch[1]) / 60 : 1;
  return {
    energyKwh: Number.isFinite(energy) ? energy : 100,
    socStart: Number.isFinite(soc) ? soc : 0.8,
    powerKw: Number.isFinite(power) ? power : 20,
    hours: Number.isFinite(hours) && hours > 0 ? hours : 1
  };
}

export function batteryModelName(params: ReturnType<typeof inferBatteryParams>) {
  return `BatterySOC_E${token(params.energyKwh)}_P${token(params.powerKw)}_S${token(params.socStart)}`;
}

function batterySource(params: ReturnType<typeof inferBatteryParams>) {
  const stop = params.hours * 3600;
  const name = batteryModelName(params);
  return `model ${name}
  parameter Modelica.Units.SI.Energy E_nom = ${params.energyKwh} * 3.6e6 "Nominal energy in joules";
  parameter Real SOC_start(min=0, max=1) = ${params.socStart} "Initial state of charge";
  parameter Modelica.Units.SI.Power P = ${params.powerKw}e3 "Positive means discharge";
  Real SOC(min=0, max=1) "State of charge";
initial equation
  SOC = SOC_start;
equation
  der(SOC) = -P / E_nom;
  annotation(experiment(StartTime=0, StopTime=${stop}, Tolerance=1e-6, Interval=${Math.max(stop / 200, 0.1)}));
end ${name};
`;
}

export function inferModelicaSpec(text?: string) {
  const value = String(text || '');
  const wantsRc = /rc|电路|电容|电阻/i.test(value) && !/电池|soc|荷电/i.test(value);
  if (wantsRc) {
    return {
      name: 'RCSeriesCircuit',
      outputs: ['time', 'capacitor.v', 'resistor.i'],
      options: { start_time: 0, stop_time: 1, number_of_intervals: 200, solver: 'dassl' }
    };
  }
  const battery = inferBatteryParams(value);
  return {
    name: batteryModelName(battery),
    outputs: ['time', 'SOC'],
    options: {
      start_time: 0,
      stop_time: battery.hours * 3600,
      number_of_intervals: 200,
      solver: 'dassl'
    },
    battery
  };
}

export function defaultModelicaSource(ideaTitle?: string) {
  const spec = inferModelicaSpec(ideaTitle);
  const rc = path.join(process.cwd(), 'examples', 'modelica-rc-circuit', 'RCSeriesCircuit.mo');
  if (spec.name === 'RCSeriesCircuit' && fs.existsSync(rc)) {
    return { ...spec, code: fs.readFileSync(rc, 'utf8') };
  }
  const battery = inferBatteryParams(ideaTitle);
  return { ...inferModelicaSpec(ideaTitle), code: batterySource(battery) };
}

async function gatewayFetch(pathname: string, init?: RequestInit) {
  const response = await fetch(`${resolveModelicaGatewayUrl()}${pathname}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      'X-API-Key': resolveModelicaApiKey(),
      ...(init?.headers || {})
    }
  });
  const text = await response.text();
  let body: unknown = text;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  if (!response.ok) {
    const record = asErrorRecord(body);
    const detail = record.detail ?? record.error ?? record.message;
    throw new Error(
      typeof detail === 'string' && detail.trim()
        ? detail
        : typeof body === 'string' && body.trim() && body !== 'Internal Server Error'
          ? body
          : `OpenModelica 网关 ${response.status}：${pathname} 调用失败。`
    );
  }
  return body;
}

export async function getModelicaHealth() {
  try {
    const body = (await gatewayFetch('/health')) as { ok?: boolean; error?: string; ompython?: boolean; modelica?: string };
    let info: Record<string, unknown> | null = null;
    try {
      info = (await gatewayFetch('/v1/info')) as Record<string, unknown>;
    } catch {
      info = null;
    }
    return {
      ok: body.ok === true,
      url: resolveModelicaGatewayUrl(),
      ompython: body.ompython,
      modelica: body.modelica,
      info,
      error: body.error
    };
  } catch (error) {
    return {
      ok: false,
      url: resolveModelicaGatewayUrl(),
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

export async function checkModelicaModel(modelName: string, code: string) {
  return gatewayFetch('/v1/models/check', {
    method: 'POST',
    body: JSON.stringify({ model: { model_name: modelName, modelica_code: code } })
  });
}

export async function simulateModelica(input: {
  modelName: string;
  code: string;
  parameters?: Record<string, unknown>;
  outputs?: string[];
  options?: Record<string, unknown>;
}) {
  const created = (await gatewayFetch('/v1/simulations', {
    method: 'POST',
    body: JSON.stringify({
      model: { model_name: input.modelName, modelica_code: input.code },
      parameters: input.parameters || {},
      outputs: input.outputs || ['time', 'SOC'],
      options: input.options || { start_time: 0, stop_time: 3600, number_of_intervals: 200, solver: 'dassl' }
    })
  })) as { job_id: string; status_url: string; result_url: string };
  const deadline = Date.now() + 10 * 60 * 1000;
  while (Date.now() < deadline) {
    const status = (await gatewayFetch(created.status_url || `/v1/jobs/${created.job_id}`)) as {
      status?: string;
      error?: string;
    };
    if (status.status === 'succeeded') {
      return gatewayFetch(created.result_url || `/v1/jobs/${created.job_id}/result`);
    }
    if (status.status === 'failed') {
      throw new Error(status.error || 'OpenModelica 仿真失败');
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error('OpenModelica 仿真超时');
}

export function writeModelicaResult(sessionId: string, ideaId: string, payload: Record<string, unknown>) {
  const result = {
    ok: true,
    success: true,
    engine: MODELICA_ENGINE,
    status: 'success',
    model_name: payload.model_name,
    series: payload.series,
    artifacts: payload.artifacts,
    parameters_applied: payload.parameters_applied
  };
  writeWorkspaceText(sessionId, ideaId, 'result.json', `${JSON.stringify(result, null, 2)}\n`);
  const { dir, resultPath } = modelicaDirs(sessionId, ideaId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(resultPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  return result;
}
