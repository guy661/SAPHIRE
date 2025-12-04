const API_BASE_URL = 'http://localhost:3001/api';

// Helper for handling API responses
async function handleResponse(response) {
    if (!response.ok) {
        if (response.status === 401) {
            // This could be a session timeout. The router should handle the redirect.
            // Returning a specific error or an empty object might be useful.
            throw new Error('Unauthorized');
        }
        const data = await response.json().catch(() => ({ error: 'Invalid JSON response' }));
        throw new Error(data.error || `Request failed with status ${response.status}`);
    }
    return response.json();
}

export async function loginUser(username, password) {
  const response = await fetch(`${API_BASE_URL}/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  return handleResponse(response);
}

export async function logoutUser() {
  await fetch(`${API_BASE_URL}/logout`, { method: 'POST' });
}

export async function getDashboards() {
  const response = await fetch(`${API_BASE_URL}/dashboards`);
  return handleResponse(response).catch(err => {
      // For this specific case, we return an empty array to prevent UI crashes on 401
      if (err.message === 'Unauthorized') return [];
      throw err;
  });
}

export async function createDashboard(name: string) {
  const response = await fetch(`${API_BASE_URL}/dashboards`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  });
  return handleResponse(response);
}

export async function getDashboardById(id: string) {
    const response = await fetch(`${API_BASE_URL}/dashboards/${id}`);
    return handleResponse(response);
}

export async function runDashboardSearch(id: string) {
    const response = await fetch(`${API_BASE_URL}/dashboards/${id}/run-search`, {
        method: 'POST'
    });
    return handleResponse(response);
}

export async function getJobStatus(jobId: string) {
    const response = await fetch(`${API_BASE_URL}/job/${jobId}`);
    return handleResponse(response);
}

export async function runPersonalizationChat(dashboardId: string, message: string) {
    const response = await fetch(`${API_BASE_URL}/dashboards/${dashboardId}/personalization-chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message }),
    });
    return handleResponse(response);
}
