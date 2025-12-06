const API_BASE_URL = 'http://localhost:3001/api';

// Helper for handling API responses
async function handleResponse(response: Response) {
    if (!response.ok) {
        if (response.status === 401) {
            throw new Error('Unauthorized');
        }
        const data = await response.json().catch(() => ({ error: 'Invalid JSON response' }));
        throw new Error(data.error || `Request failed with status ${response.status}`);
    }
    return response.json();
}

// Wrapper for fetch that always includes credentials
async function fetchWithAuth(url: string, options: RequestInit = {}) {
    const defaultOptions: RequestInit = {
        credentials: 'include', // CRITICAL for sending cookies across origins (port 5173 -> 3001)
    };
    
    // Merge headers correctly
    const headers = {
        ...(options.headers || {}),
    };

    return fetch(url, { ...defaultOptions, ...options, headers });
}

export async function loginUser(username, password) {
  const response = await fetchWithAuth(`${API_BASE_URL}/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  return handleResponse(response);
}

export async function registerUser(username, password, language) {
    const response = await fetchWithAuth(`${API_BASE_URL}/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password, language }),
    });
    return handleResponse(response);
}

export async function logoutUser() {
  await fetchWithAuth(`${API_BASE_URL}/logout`, { method: 'POST' });
}

export async function getCurrentUser() {
    const response = await fetchWithAuth(`${API_BASE_URL}/user`);
    return handleResponse(response);
}

export async function getDashboards() {
  const response = await fetchWithAuth(`${API_BASE_URL}/dashboards`);
  return handleResponse(response).catch(err => {
      if (err.message === 'Unauthorized') return [];
      throw err;
  });
}

export async function createDashboard(name: string) {
  const response = await fetchWithAuth(`${API_BASE_URL}/dashboards`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  });
  return handleResponse(response);
}

export async function getDashboardById(id: string) {
    const response = await fetchWithAuth(`${API_BASE_URL}/dashboards/${id}`);
    return handleResponse(response);
}

export async function getDashboardJobs(id: string) {
    const response = await fetchWithAuth(`${API_BASE_URL}/dashboards/${id}/jobs`);
    return handleResponse(response);
}

export async function runDashboardSearch(id: string, rssCategories: string[]) {
    const response = await fetchWithAuth(`${API_BASE_URL}/dashboards/${id}/run-search`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rss_categories: rssCategories }),
    });
    return handleResponse(response);
}

export async function getJobStatus(jobId: string) {
    const response = await fetchWithAuth(`${API_BASE_URL}/job/${jobId}`);
    return handleResponse(response);
}

export async function getJobClusters(jobId: string) {
    const response = await fetchWithAuth(`${API_BASE_URL}/jobs/${jobId}/clusters`);
    return handleResponse(response);
}

export async function postJobChat(jobId: string, message: string, chatHistory: any[], summary: string) {
    const response = await fetchWithAuth(`${API_BASE_URL}/jobs/${jobId}/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message, chatHistory, summary }),
    });
    return handleResponse(response);
}

export async function runPersonalizationChat(dashboardId: string, message: string) {
    const response = await fetchWithAuth(`${API_BASE_URL}/dashboards/${dashboardId}/personalization-chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message }),
    });
    return handleResponse(response);
}

export async function getAvailableRssCategories() {
    const response = await fetchWithAuth(`${API_BASE_URL}/rss/categories`);
    return handleResponse(response);
}

export async function submitFeedback(clusterId: number, feedbackType: 'like' | 'dislike' | null) {
    const response = await fetchWithAuth(`${API_BASE_URL}/feedback`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clusterId, feedbackType }),
    });
    return handleResponse(response);
}

export async function updateDashboardSettings(id: string, settings: { summary_style?: string, interval_minutes?: number, is_active?: boolean }) {
    const response = await fetchWithAuth(`${API_BASE_URL}/dashboards/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(settings),
    });
    return handleResponse(response);
}
