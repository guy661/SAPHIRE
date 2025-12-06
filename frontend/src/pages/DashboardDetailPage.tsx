import { useParams, Link as RouterLink } from 'react-router-dom';
import { Typography, Box, Button, CircularProgress, Alert, List, ListItemButton, ListItemText, Divider, Paper, FormGroup, FormControlLabel, Checkbox, TextField, IconButton } from '@mui/material';
import { useEffect, useState, useCallback, useRef } from 'react';
import { getDashboardById, getDashboardJobs, runDashboardSearch, getAvailableRssCategories, postJobChat } from '../services/api';
import { Panel, PanelGroup, PanelResizeHandle } from 'react-resizable-panels';
import { styled } from '@mui/material/styles';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import SendIcon from '@mui/icons-material/Send';
import SettingsIcon from '@mui/icons-material/Settings';
import PlayArrowIcon from '@mui/icons-material/PlayArrow';
import PauseIcon from '@mui/icons-material/Pause';

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

const markdownComponents = {
    h1: ({...props}) => <Typography variant="h4" component="h1" gutterBottom {...props} />,
    h2: ({...props}) => <Typography variant="h5" component="h2" gutterBottom {...props} />,
    h3: ({...props}) => <Typography variant="h6" component="h3" gutterBottom {...props} />,
    p: ({...props}) => <Typography variant="body1" paragraph sx={{ lineHeight: 1.7, fontSize: '1.1rem' }} {...props} />,
    a: ({...props}) => <Link {...props} />,
    li: ({...props}) => <li style={{marginBottom: '8px'}}><Typography component="span" {...props} /></li>
};

interface ChatMessage {
    role: 'user' | 'model';
    parts: { text: string }[];
}

export default function DashboardDetailPage() {
    const { id } = useParams<{ id: string }>();
    const [dashboard, setDashboard] = useState<any>(null);
    const [jobs, setJobs] = useState<any[]>([]);
    const [selectedJob, setSelectedJob] = useState<any>(null);
    
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [isPolling, setIsPolling] = useState(false);
    const [runningJobId, setRunningJobId] = useState<string | null>(null);
    
    const [availableCategories, setAvailableCategories] = useState<{key: string, name: string}[]>([]);
    const [selectedCategories, setSelectedCategories] = useState<string[]>([]);

    // Chat State
    const [chatHistory, setChatHistory] = useState<ChatMessage[]>([]);
    const [chatInput, setChatInput] = useState('');
    const [isChatLoading, setIsChatLoading] = useState(false);
    const chatEndRef = useRef<HTMLDivElement>(null);

    // Audio State
    const [isPlaying, setIsPlaying] = useState(false);
    const audioRef = useRef<HTMLAudioElement | null>(null);

    const scrollToBottom = () => {
        chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    };

    useEffect(() => {
        scrollToBottom();
    }, [chatHistory]);

    // Cleanup audio on unmount
    useEffect(() => {
        return () => {
            if (audioRef.current) {
                audioRef.current.pause();
                audioRef.current = null;
            }
        };
    }, []);

    const handleSelectJob = useCallback(async (jobId: string) => {
        const job = jobs.find(j => j.id === jobId);
        if (job) {
            setSelectedJob(job);
            setChatHistory([]); // Clear chat history when switching jobs
            
            // Stop audio if switching jobs
            if (audioRef.current) {
                audioRef.current.pause();
                audioRef.current = null;
                setIsPlaying(false);
            }
        }
    }, [jobs]);

    const handlePlayAudio = () => {
        if (!selectedJob) return;

        if (isPlaying && audioRef.current) {
            audioRef.current.pause();
            setIsPlaying(false);
        } else {
            if (!audioRef.current) {
                // API call to the specific job's audio summary
                const audio = new Audio(`http://localhost:3001/api/audio-summary?jobId=${selectedJob.id}`);
                // Important: Ensure credentials (cookies) are sent if the API requires auth
                // The `new Audio(url)` constructor handles simple GET requests. 
                // Since your API requires session cookies and cross-origin might be an issue depending on setup,
                // standard Audio element might fail if strict CORS/Auth is needed and not handled by browser implicitly for media.
                // However, for `localhost`, typically cookies are shared if path matches.
                // A more robust way for authenticated audio is fetching blob -> blobURL.
                
                // Given the current setup (proxy or CORS credentials), let's try simple URL first.
                // If it fails due to Auth, we switch to fetch-blob pattern.
                
                audioRef.current = audio;
                audio.addEventListener('ended', () => {
                    setIsPlaying(false);
                    audioRef.current = null;
                });
                audio.addEventListener('error', (e) => {
                    console.error("Error playing audio.", e);
                    setIsPlaying(false);
                    setError("Fehler beim Abspielen der Audio-Zusammenfassung (evtl. nicht angemeldet?)");
                });
            }
            audioRef.current.play().catch(e => console.error("Audio playback failed:", e));
            setIsPlaying(true);
        }
    };
    
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

    useEffect(() => {
        if (!id) return;
        setLoading(true);
        Promise.all([
            getDashboardById(id),
            getDashboardJobs(id),
            getAvailableRssCategories()
        ]).then(([dashboardData, jobsData, categoriesData]) => {
            setDashboard(dashboardData);
            setJobs(jobsData);
            setAvailableCategories(categoriesData);
            
            // Use saved categories if available, otherwise select all
            if (dashboardData.selected_categories && Array.isArray(dashboardData.selected_categories) && dashboardData.selected_categories.length > 0) {
                 setSelectedCategories(dashboardData.selected_categories);
            } else {
                 setSelectedCategories(categoriesData.map((cat: any) => cat.key));
            }

            // Select the latest completed job immediately without triggering re-renders via dependencies
            if (jobsData.length > 0) {
                const latestCompleted = jobsData.find((j: any) => j.status === 'completed');
                if (latestCompleted) {
                    setSelectedJob(latestCompleted);
                    // Chat history is cleared by default logic
                }
            }
        }).catch(err => {
            setError('Fehler beim Laden des Dashboards.');
            console.error(err);
        }).finally(() => setLoading(false));
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [id]);

    useEffect(() => {
        if (!runningJobId) return;
        const interval = setInterval(() => {
             fetchJobs(); 
        }, 5000);
        return () => clearInterval(interval);
    }, [runningJobId, fetchJobs]);

    const handleCategoryChange = (event: React.ChangeEvent<HTMLInputElement>) => {
        const { name, checked } = event.target;
        setSelectedCategories(prev => 
            checked ? [...prev, name] : prev.filter(key => key !== name)
        );
    };

    const handleRunSearch = useCallback(async () => {
        if (!id || selectedCategories.length === 0) {
            setError("Bitte wählen Sie mindestens eine Feed-Kategorie aus.");
            return;
        };

        console.log(`[DEBUG] handleRunSearch triggered. Sending categories:`, selectedCategories);

        setError(null);
        setChatHistory([]);
        const optimisticJobId = `temp-${Math.random()}`;
        const optimisticJob = { id: optimisticJobId, status: 'processing', created_at: new Date().toISOString(), meta_summary: null };
        setJobs(prev => [optimisticJob, ...prev]);
        setSelectedJob(optimisticJob);
        setIsPolling(true);

        try {
            const runningJob = await runDashboardSearch(id, selectedCategories);
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
            console.error(err);
            setIsPolling(false);
            setJobs(prev => prev.filter(j => j.id !== optimisticJobId));
        }
    }, [id, selectedCategories]);

    const handleChatSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!chatInput.trim() || !selectedJob) return;

        const userMessage = chatInput;
        setChatInput('');
        setChatHistory(prev => [...prev, { role: 'user', parts: [{ text: userMessage }] }]);
        setIsChatLoading(true);

        try {
            const result = await postJobChat(selectedJob.id, userMessage, chatHistory, selectedJob.meta_summary);
            setChatHistory(prev => [...prev, { role: 'model', parts: [{ text: result.answer }] }]);
        } catch (err) {
            console.error("Chat error:", err);
            setChatHistory(prev => [...prev, { role: 'model', parts: [{ text: 'Entschuldigung, ich konnte darauf nicht antworten. Bitte versuchen Sie es später noch einmal.' }] }]);
        } finally {
            setIsChatLoading(false);
        }
    };
    
    if (loading) return <Box sx={{display: 'flex', justifyContent: 'center', alignItems: 'center', height: '100%', p: 4}}><CircularProgress /></Box>;
    if (error) return <Alert severity="error" sx={{ m: 4 }}>{error}</Alert>;
    if (!dashboard) return <Alert severity="warning" sx={{ m: 4 }}>Dashboard nicht gefunden.</Alert>;

    return (
        <Box sx={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>
             <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', p: 2, flexShrink: 0, borderBottom: '1px solid', borderColor: 'divider' }}>
                <Typography variant="h5">{dashboard.name}</Typography>
                <Box>
                    {selectedJob && selectedJob.status === 'completed' && (
                        <IconButton onClick={handlePlayAudio} title="Zusammenfassung vorlesen" sx={{ mr: 1 }}>
                            {isPlaying ? <PauseIcon color="primary" /> : <PlayArrowIcon />}
                        </IconButton>
                    )}
                    <IconButton component={RouterLink} to={`/dashboard/${id}/settings`} title="Einstellungen" sx={{ mr: 1 }}>
                        <SettingsIcon />
                    </IconButton>
                    <Button variant="outlined" component={RouterLink} to={`/dashboard/${id}/edit`}>Thema bearbeiten</Button>
                </Box>
            </Box>

            <PanelGroup direction="horizontal" style={{ flexGrow: 1, height: 0 }}>
                <Panel defaultSize={25} minSize={20} maxSize={40}>
                    <Box sx={{ p: 1, height: '100%', display: 'flex', flexDirection: 'column', overflowY: 'auto' }}>
                        
                        <Typography variant="subtitle2" sx={{ px: 2, py: 1, color: 'text.secondary' }}>Quellen auswählen</Typography>
                        <Paper variant="outlined" sx={{ p: 1, m:1, maxHeight: '200px', overflowY: 'auto' }}>
                            <FormGroup>
                                {availableCategories.map(cat => (
                                    <FormControlLabel 
                                        key={cat.key}
                                        control={
                                            <Checkbox 
                                                checked={selectedCategories.includes(cat.key)} 
                                                onChange={handleCategoryChange}
                                                name={cat.key}
                                                size="small"
                                            />
                                        }
                                        label={<Typography variant="body2">{cat.name}</Typography>}
                                    />
                                ))}
                            </FormGroup>
                        </Paper>
                        
                        <Button variant="contained" onClick={handleRunSearch} disabled={isPolling || availableCategories.length === 0 || selectedCategories.length === 0} sx={{ m: 1 }}>
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
                    <Box sx={{ p: 0, height: '100%', overflowY: 'hidden', display: 'flex', flexDirection: 'column' }}>
                        <Box sx={{ flexGrow: 1, overflowY: 'auto', p: { xs: 2, md: 4 } }}>
                            {selectedJob ? (
                                <>
                                    {selectedJob.meta_summary && (
                                        <Box mb={4}>
                                            <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
                                                {selectedJob.meta_summary}
                                            </ReactMarkdown>
                                        </Box>
                                    )}

                                    {/* Removed Cluster Cards */}
                                    
                                    {(isPolling || selectedJob?.status === 'processing') && (
                                         <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '200px', color: 'text.secondary', flexDirection: 'column' }}>
                                            <CircularProgress />
                                            <Typography sx={{ mt: 2 }}>Analyse wird verarbeitet...</Typography>
                                            <Typography variant="caption" sx={{ mt: 1 }}>Job ID: {selectedJob?.id.startsWith('temp-') ? 'wird erstellt...' : selectedJob?.id}</Typography>
                                         </Box>
                                    )}
                                    
                                    {/* Chat History Display */}
                                    {chatHistory.length > 0 && (
                                        <Box sx={{ mt: 4, mb: 2 }}>
                                            <Divider sx={{ mb: 2 }}>
                                                <Typography variant="caption" color="text.secondary">RÜCKFRAGEN & ANTWORTEN</Typography>
                                            </Divider>
                                            {chatHistory.map((msg, index) => (
                                                <Box key={index} sx={{ 
                                                    display: 'flex', 
                                                    justifyContent: msg.role === 'user' ? 'flex-end' : 'flex-start', 
                                                    mb: 2 
                                                }}>
                                                    <Paper sx={{ 
                                                        p: 2, 
                                                        maxWidth: '80%', 
                                                        bgcolor: msg.role === 'user' ? 'primary.light' : 'background.paper',
                                                        color: msg.role === 'user' ? 'primary.contrastText' : 'text.primary'
                                                    }}>
                                                        <Typography variant="body1">{msg.parts[0].text}</Typography>
                                                    </Paper>
                                                </Box>
                                            ))}
                                            <div ref={chatEndRef} />
                                        </Box>
                                    )}
                                </>
                            ) : (
                                 <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', color: 'text.secondary', flexDirection: 'column' }}>
                                    <Typography variant="h6">Keine Zusammenfassung ausgewählt</Typography>
                                    <Typography sx={{ mt: 1 }}>Wählen Sie eine Analyse aus der Liste aus oder erstellen Sie eine neue.</Typography>
                                </Box>
                            )}
                        </Box>
                        
                        {/* Chat Input Area - Sticky at bottom */}
                        {selectedJob && selectedJob.status === 'completed' && (
                            <Box component="form" onSubmit={handleChatSubmit} sx={{ p: 2, borderTop: '1px solid', borderColor: 'divider', bgcolor: 'background.paper' }}>
                                <Box sx={{ display: 'flex', gap: 1 }}>
                                    <TextField
                                        fullWidth
                                        placeholder="Stellen Sie eine Frage zu dieser Zusammenfassung..."
                                        value={chatInput}
                                        onChange={(e) => setChatInput(e.target.value)}
                                        disabled={isChatLoading}
                                        variant="outlined"
                                        size="small"
                                    />
                                    <IconButton type="submit" color="primary" disabled={isChatLoading || !chatInput.trim()}>
                                        {isChatLoading ? <CircularProgress size={24} /> : <SendIcon />}
                                    </IconButton>
                                </Box>
                            </Box>
                        )}
                    </Box>
                </Panel>
            </PanelGroup>
        </Box>
    );
}
