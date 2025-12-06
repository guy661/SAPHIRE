import { useParams, Link as RouterLink } from 'react-router-dom';
import { Typography, Box, Button, CircularProgress, Alert, List, ListItemButton, ListItemText, Divider, Paper, FormGroup, FormControlLabel, Checkbox } from '@mui/material';
import { useEffect, useState, useCallback, useRef } from 'react';
import { getDashboardById, getDashboardJobs, runDashboardSearch, getJobClusters, getAvailableRssCategories } from '../services/api';
import { Panel, PanelGroup, PanelResizeHandle } from 'react-resizable-panels';
import { styled } from '@mui/material/styles';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import ClusterCard, { Cluster } from '../components/ClusterCard';


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

export default function DashboardDetailPage() {
    const { id } = useParams<{ id: string }>();
    const [dashboard, setDashboard] = useState<any>(null);
    const [jobs, setJobs] = useState<any[]>([]);
    const [selectedJob, setSelectedJob] = useState<any>(null);
    const [clusters, setClusters] = useState<Cluster[]>([]);
    const [isClusterLoading, setIsClusterLoading] = useState(false);
    
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [isPolling, setIsPolling] = useState(false);
    const [runningJobId, setRunningJobId] = useState<string | null>(null);
    
    const [availableCategories, setAvailableCategories] = useState<{key: string, name: string}[]>([]);
    const [selectedCategories, setSelectedCategories] = useState<string[]>([]);

    useEffect(() => {
        getAvailableRssCategories().then(data => {
            setAvailableCategories(data);
            // Select all categories by default
            setSelectedCategories(data.map(cat => cat.key));
        }).catch(err => {
            console.error("Could not fetch RSS categories", err);
        });
    }, []);

    const handleSelectJob = useCallback(async (jobId: string) => {
        const job = jobs.find(j => j.id === jobId);
        if (job) {
            setSelectedJob(job);
            setClusters([]); // Clear previous clusters

            if (job.status === 'completed') {
                setIsClusterLoading(true);
                try {
                    const clusterData = await getJobClusters(job.id);
                    setClusters(clusterData);
                } catch (err) {
                    console.error("Could not fetch job clusters.", err);
                    setError("Fehler beim Laden der Artikel-Cluster.");
                } finally {
                    setIsClusterLoading(false);
                }
            }
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
                    handleSelectJob(latestCompleted.id);
                }
            }
        }).catch(err => {
            setError('Fehler beim Laden des Dashboards.');
            console.error(err);
        }).finally(() => setLoading(false));
    }, [id, handleSelectJob]);

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
        setClusters([]);
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
    }, [id, selectedCategories]); // Ensures the function has the latest state
    
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
                    <Box sx={{ p: { xs: 2, md: 4 }, height: '100%', overflowY: 'auto', display: 'flex', flexDirection: 'column' }}>
                        {selectedJob ? (
                            <>
                                {selectedJob.meta_summary && (
                                    <Box mb={4}>
                                        <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
                                            {selectedJob.meta_summary}
                                        </ReactMarkdown>
                                    </Box>
                                )}

                                {isClusterLoading ? (
                                    <Box sx={{ display: 'flex', justifyContent: 'center', p: 4 }}><CircularProgress /></Box>
                                ) : clusters.length > 0 ? (
                                    clusters.map(cluster => (
                                        <ClusterCard key={cluster.id} cluster={cluster} />
                                    ))
                                ) : (
                                    selectedJob.status === 'completed' && <Typography>Keine Artikel-Cluster für diese Analyse gefunden.</Typography>
                                )}
                                
                                {(isPolling || selectedJob?.status === 'processing') && !isClusterLoading && (
                                     <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', color: 'text.secondary', flexDirection: 'column' }}>
                                        <CircularProgress />
                                        <Typography sx={{ mt: 2 }}>Analyse wird verarbeitet...</Typography>
                                        <Typography variant="caption" sx={{ mt: 1 }}>Job ID: {selectedJob?.id.startsWith('temp-') ? 'wird erstellt...' : selectedJob?.id}</Typography>
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
                </Panel>
            </PanelGroup>
        </Box>
    );
}
