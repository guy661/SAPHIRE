import { useParams, Link as RouterLink } from 'react-router-dom';
import { Typography, Box, Button, CircularProgress, Alert, List, ListItemButton, ListItemText, Divider, Paper, Link, TextField, IconButton } from '@mui/material';
import { useEffect, useState, useCallback, useRef } from 'react';
import { getDashboardById, getDashboardJobs, runDashboardSearch, getJobStatus, postJobChat } from '../services/api';
import { Panel, PanelGroup, PanelResizeHandle } from 'react-resizable-panels';
import { styled } from '@mui/material/styles';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import SendIcon from '@mui/icons-material/Send';
import SmartToyIcon from '@mui/icons-material/SmartToy';
import AccountCircleIcon from '@mui/icons-material/AccountCircle';


const StyledResizeHandle = styled(PanelResizeHandle)(({ theme }) => ({
    width: '8px',
    background: 'transparent',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    transition: 'background 0.2s',
    '&:hover': {
        background: theme.palette.action.hover,
    },
    '&::after': {
        content: '""',
        display: 'block',
        width: '1px',
        height: '40px',
        background: theme.palette.divider,
    }
}));

// Custom components for Markdown rendering to integrate with Material-UI
const markdownComponents = {
    h1: ({...props}) => <Typography variant="h4" component="h1" gutterBottom {...props} />,
    h2: ({...props}) => <Typography variant="h5" component="h2" gutterBottom {...props} />,
    h3: ({...props}) => <Typography variant="h6" component="h3" gutterBottom {...props} />,
    p: ({...props}) => <Typography variant="body1" paragraph sx={{ lineHeight: 1.7, fontSize: '1.1rem' }} {...props} />,
    a: ({...props}) => <Link {...props} />,
    li: ({...props}) => <li style={{marginBottom: '8px'}}><Typography component="span" {...props} /></li>
};

export default function DashboardDetailPage() {
    const { id } = useParams<{ id: string }>();
    const [dashboard, setDashboard] = useState<any>(null);
    const [jobs, setJobs] = useState<any[]>([]);
    const [selectedJob, setSelectedJob] = useState<any>(null);
    
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [isPolling, setIsPolling] = useState(false);
    const [runningJobId, setRunningJobId] = useState<string | null>(null);

    const [chatHistory, setChatHistory] = useState<any[]>([]);
    const [isChatLoading, setChatLoading] = useState(false);
    const chatContainerRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        // Scroll to the bottom of the chat container when new messages are added
        if (chatContainerRef.current) {
            chatContainerRef.current.scrollTop = chatContainerRef.current.scrollHeight;
        }
    }, [chatHistory]);
    
    const handleSelectJob = useCallback(async (jobId: string) => {
        const job = jobs.find(j => j.id === jobId);
        if (job) {
            setSelectedJob(job);
            setChatHistory([]); // Reset chat when a new job is selected
        }
    }, [jobs]);
    
    const fetchJobs = useCallback(() => {
        if (!id) return;
        getDashboardJobs(id)
            .then(data => {
                setJobs(data);
                const stillRunningJob = data.find(job => job.id === runningJobId);
                if (stillRunningJob && (stillRunningJob.status === 'completed' || stillRunningJob.status === 'failed')) {
                    handleSelectJob(stillRunningJob.id);
                    setRunningJobId(null);
                    setIsPolling(false);
                }
            })
            .catch(err => console.error("Could not fetch dashboard jobs.", err));
    }, [id, runningJobId, handleSelectJob]);

    // Initial data load
    useEffect(() => {
        if (!id) return;
        setLoading(true);
        Promise.all([
            getDashboardById(id),
            getDashboardJobs(id)
        ]).then(([dashboardData, jobsData]) => {
            setDashboard(dashboardData);
            setJobs(jobsData);
            if (jobsData.length > 0) {
                const latestCompleted = jobsData.find(j => j.status === 'completed');
                if (latestCompleted) {
                    // Select the job directly here instead of calling the callback
                    setSelectedJob(latestCompleted);
                    setChatHistory([]);
                }
            }
        }).catch(err => {
            setError('Fehler beim Laden des Dashboards.');
            console.error(err);
        }).finally(() => setLoading(false));
    }, [id]); // Dependency array simplified to break the loop

    // Polling for a running job
    useEffect(() => {
        if (!runningJobId) return;
        const interval = setInterval(() => {
             fetchJobs(); 
        }, 5000);
        return () => clearInterval(interval);
    }, [runningJobId, fetchJobs]);


    const handleRunSearch = async () => {
        if (!id) return;
        setError(null);
        const optimisticJobId = `temp-${Math.random()}`;
        const optimisticJob = { id: optimisticJobId, status: 'processing', created_at: new Date().toISOString(), meta_summary: null };
        setJobs(prev => [optimisticJob, ...prev]);
        setSelectedJob(optimisticJob);
        setIsPolling(true);

        try {
            const runningJob = await runDashboardSearch(id);
            if(runningJob.jobId) {
                setJobs(prev => prev.map(j => j.id === optimisticJobId ? { ...j, id: runningJob.jobId, status: 'processing' } : j));
                setRunningJobId(runningJob.jobId);
            } else {
                setIsPolling(false);
                setError(runningJob.message || "Keine neuen Artikel für eine Zusammenfassung gefunden.");
                setJobs(prev => prev.filter(j => j.id !== optimisticJobId));
            }
        } catch (err) {
            setError('Fehler beim Starten des Jobs.');
            setIsPolling(false);
            setJobs(prev => prev.filter(j => j.id !== optimisticJobId));
        }
    };

    const handleChatSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
        event.preventDefault();
        const formData = new FormData(event.currentTarget);
        const message = formData.get('message') as string;
        if (!message || !selectedJob) return;

        const userMessage = { role: 'user', parts: [{ text: message }] };
        const newChatHistory = [...chatHistory, userMessage];
        setChatHistory(newChatHistory);
        setChatLoading(true);
        (event.target as HTMLFormElement).reset();

        try {
            const res = await postJobChat(selectedJob.id, message, newChatHistory, selectedJob.meta_summary);
            const modelMessage = { role: 'model', parts: [{ text: res.answer }] };
            setChatHistory(prev => [...prev, modelMessage]);
        } catch (error) {
            console.error("Failed to get chat response", error);
            const errorMessage = { role: 'model', parts: [{ text: "Entschuldigung, ich konnte keine Antwort generieren." }] };
            setChatHistory(prev => [...prev, errorMessage]);
        } finally {
            setChatLoading(false);
        }
    };
    
    if (loading) return <Box sx={{display: 'flex', justifyContent: 'center', p: 4}}><CircularProgress /></Box>;
    if (error && !dashboard) return <Alert severity="error" sx={{ m: 4 }}>{error}</Alert>;

    return (
        <Box sx={{ display: 'flex', flexDirection: 'column', height: 'calc(100vh - 64px)' }}>
             <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', p: 2, flexShrink: 0, borderBottom: '1px solid', borderColor: 'divider' }}>
                <Typography variant="h5">{dashboard?.name}</Typography>
                <Button variant="outlined" component={RouterLink} to={`/dashboard/${id}/edit`}>Thema bearbeiten</Button>
            </Box>

            <PanelGroup direction="horizontal" style={{ flexGrow: 1, overflow: 'auto' }}>
                <Panel defaultSize={25} minSize={20} maxSize={40}>
                    <Box sx={{ p: 1, height: '100%', display: 'flex', flexDirection: 'column', overflowY: 'auto' }}>
                        <Button variant="contained" onClick={handleRunSearch} disabled={isPolling} sx={{ m: 1 }}>
                            {isPolling ? `Analyse läuft...` : 'Neue Zusammenfassung'}
                        </Button>
                        <Divider sx={{ my: 1 }} />
                         <Typography variant="subtitle2" sx={{ px: 2, py: 1, color: 'text.secondary' }}>Vergangene Analysen</Typography>
                        <List dense>
                            {jobs.map(job => (
                                <ListItemButton key={job.id} selected={selectedJob?.id === job.id} onClick={() => handleSelectJob(job.id)}>
                                    <ListItemText 
                                        primary={`Analyse vom ${new Date(job.created_at).toLocaleString('de-DE')}`}
                                        secondary={job.status} 
                                    />
                                </ListItemButton>
                            ))}
                        </List>
                    </Box>
                </Panel>
                <StyledResizeHandle />
                <Panel defaultSize={75} minSize={60}>
                    <Box sx={{ p: { xs: 2, md: 4 }, height: '100%', overflowY: 'auto', display: 'flex', flexDirection: 'column' }}>
                        {selectedJob && selectedJob.meta_summary ? (
                            <>
                                <Box flexGrow={1}>
                                    <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
                                        {selectedJob.meta_summary}
                                    </ReactMarkdown>
                                </Box>
                                <Divider sx={{ my: 2 }} />
                                <Box flexShrink={0} sx={{ maxHeight: '40%', overflowY: 'auto' }} ref={chatContainerRef}>
                                    <Typography variant="h6" sx={{ mb: 2 }}>Rückfragen</Typography>
                                    {chatHistory.map((msg, index) => (
                                        <Paper key={index} elevation={0} sx={{ p: 2, mb: 2, bgcolor: msg.role === 'user' ? 'action.hover' : 'transparent', display: 'flex' }}>
                                            {msg.role === 'user' ? <AccountCircleIcon sx={{ mr: 1.5, color: 'text.secondary' }} /> : <SmartToyIcon sx={{ mr: 1.5, color: 'primary.main' }} />}
                                            <Typography variant="body2" sx={{ whiteSpace: 'pre-wrap' }}>{msg.parts[0].text}</Typography>
                                        </Paper>
                                    ))}
                                    {isChatLoading && <CircularProgress size={24} sx={{ my: 2 }} />}
                                </Box>
                                <Box component="form" onSubmit={handleChatSubmit} sx={{ display: 'flex', alignItems: 'center', p: 1, borderTop: '1px solid', borderColor: 'divider', flexShrink: 0 }}>
                                    <TextField 
                                        name="message"
                                        fullWidth
                                        variant="outlined"
                                        placeholder="Stellen Sie eine Frage zur Zusammenfassung..."
                                        size="small"
                                        disabled={isChatLoading}
                                    />
                                    <IconButton type="submit" color="primary" disabled={isChatLoading}>
                                        <SendIcon />
                                    </IconButton>
                                </Box>
                            </>
                        ) : (
                             <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', color: 'text.secondary', flexDirection: 'column' }}>
                                 {isPolling || selectedJob?.status === 'processing' ? (
                                    <>
                                        <CircularProgress />
                                        <Typography sx={{ mt: 2 }}>Analyse wird verarbeitet...</Typography>
                                        <Typography variant="caption" sx={{ mt: 1 }}>Job ID: {selectedJob?.id.startsWith('temp-') ? 'wird erstellt...' : selectedJob?.id}</Typography>
                                    </>
                                 ) : (
                                    <>
                                        <Typography variant="h6">Keine Zusammenfassung ausgewählt</Typography>
                                        <Typography sx={{ mt: 1 }}>Wählen Sie eine Analyse aus der Liste aus oder erstellen Sie eine neue.</Typography>
                                    </>
                                 )}
                            </Box>
                        )}
                    </Box>
                </Panel>
            </PanelGroup>
        </Box>
    );
}
