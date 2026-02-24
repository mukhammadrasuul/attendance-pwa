const JSON_HEADERS = {
  'Content-Type': 'application/json; charset=utf-8',
};

exports.handler = async (event) => {
  try {
    if (event.httpMethod === 'OPTIONS') {
      return {
        statusCode: 200,
        headers: corsHeaders_(),
        body: '',
      };
    }

    const gasUrl = process.env.GAS_WEB_APP_URL;
    const sharedSecret = process.env.GAS_SHARED_SECRET;

    if (!gasUrl || !sharedSecret) {
      return response_(500, {
        ok: false,
        error: 'Missing GAS_WEB_APP_URL or GAS_SHARED_SECRET environment variables.',
      });
    }

    const path = event.path || '';
    const route = path.split('/').filter(Boolean).pop() || '';

    if (event.httpMethod === 'GET' && route === 'bootstrap') {
      const branch = event.queryStringParameters?.branch || '';
      const payload = {
        action: 'bootstrap',
        apiKey: sharedSecret,
        branch,
      };
      const data = await postToGas_(gasUrl, payload);
      return response_(200, data);
    }

    if (event.httpMethod === 'POST' && route === 'attendance') {
      const parsedBody = parseJsonSafe_(event.body || '{}');
      const payload = {
        action: 'submitAttendance',
        apiKey: sharedSecret,
        payload: parsedBody,
      };
      const data = await postToGas_(gasUrl, payload);
      return response_(200, data);
    }

    if (event.httpMethod === 'POST' && route === 'attendance-image') {
      const parsedBody = parseJsonSafe_(event.body || '{}');
      const payload = {
        action: 'uploadAttendanceImage',
        apiKey: sharedSecret,
        payload: parsedBody,
      };
      const data = await postToGas_(gasUrl, payload);
      return response_(200, data);
    }

    return response_(404, { ok: false, error: 'Not Found' });
  } catch (err) {
    console.error(err);
    return response_(500, { ok: false, error: err.message || 'Internal server error' });
  }
};

async function postToGas_(url, payload) {
  const res = await fetch(url, {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify(payload),
  });

  const text = await res.text();
  const data = parseJsonSafe_(text);

  if (!res.ok) {
    return {
      ok: false,
      error: data?.error || `Apps Script returned ${res.status}`,
      status: res.status,
    };
  }

  return data;
}

function parseJsonSafe_(input) {
  try {
    return JSON.parse(input);
  } catch (_err) {
    return { ok: false, error: 'Invalid JSON payload' };
  }
}

function response_(statusCode, body) {
  return {
    statusCode,
    headers: {
      ...JSON_HEADERS,
      ...corsHeaders_(),
    },
    body: JSON.stringify(body),
  };
}

function corsHeaders_() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
}
