import { useParams } from 'react-router-dom';
import { Typography, Box, Button, CircularProgress, Alert, List, ListItemButton, ListItemText, Divider, Paper } from '@mui/material';
import { useEffect, useState, useRef } from 'react';
import { getDashboardById, runDashboardSearch, getJobStatus } from '../services/api';
import { Panel, PanelGroup, PanelResizeHandle } from 'react-resizable-panels';
import { styled } from '@mui/material/styles';

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

export default function DashboardDetailPage() {
    const { id } = useParams<{ id: string }>();
    const [dashboard, setDashboard] = useState<any>(null);
    const [job, setJob] = useState<any>(null);
    const [selectedArticle, setSelectedArticle] = useState<any>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [isPolling, setIsPolling] = useState(false);

    const pollingIntervalRef = useRef<number | null>(null);

    useEffect(() => {
        if (!id) return;
        getDashboardById(id)
            .then(data => { setDashboard(data); setLoading(false); })
            .catch(err => {
                setError('Fehler beim Laden des Dashboards.');
                setLoading(false);
                console.error(err);
            });
    }, [id]);

    useEffect(() => {
        if (isPolling && job?.id) {
            pollingIntervalRef.current = window.setInterval(async () => {
                try {
                    const jobStatus = await getJobStatus(job.id);
                    setJob(jobStatus);
                    if (jobStatus.status === 'completed' || jobStatus.status === 'failed') {
                        setIsPolling(false);
                    }
                } catch (err) {
                    setError('Fehler beim Abrufen des Job-Status.');
                    setIsPolling(false);
                }
            }, 3000);
        }
        return () => { if (pollingIntervalRef.current) clearInterval(pollingIntervalRef.current); };
    }, [isPolling, job?.id]);

    const handleRunSearch = async () => {
        if (!id) return;
        setJob(null);
        setSelectedArticle(null);
        setError(null);
        setIsPolling(true);
        try {
            const runningJob = await runDashboardSearch(id);
            setJob(runningJob);
        } catch (err) {
            setError('Fehler beim Starten des Jobs.');
            setIsPolling(false);
        }
    };
    
    if (loading) return <CircularProgress sx={{ m: 4 }} />;
    if (error && !dashboard) return <Alert severity="error" sx={{ m: 4 }}>{error}</Alert>;

    return (
        <Box sx={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
            <Typography variant="h5" sx={{ mb: 2, px: 2 }}>{dashboard?.name}</Typography>

            <PanelGroup direction="horizontal" style={{ flexGrow: 1, overflow: 'auto' }}>
                <Panel defaultSize={40} minSize={25}>
                    <Box sx={{ p: 2, height: '100%', display: 'flex', flexDirection: 'column' }}>
                        <Button variant="contained" onClick={handleRunSearch} disabled={isPolling}>
                            {isPolling ? 'Analyse läuft...' : 'Zusammenfassung erstellen'}
                        </Button>
                        {isPolling && <CircularProgress size={24} sx={{ my: 2 }} />}
                        {job?.status === 'completed' && (
                            <Box sx={{ mt: 2, overflowY: 'auto' }}>
                                <Typography variant="h6">Zusammenfassung</Typography>
                                <Typography paragraph variant="body2" sx={{ my: 1, whiteSpace: 'pre-wrap' }}>{job.summary}</Typography>
                                <Divider sx={{ my: 2 }} />
                                <Typography variant="h6">Relevante Artikel ({job.articles?.length || 0})</Typography>
                                <List>
                                    {job.articles?.map(article => (
                                        <ListItemButton key={article.id} selected={selectedArticle?.id === article.id} onClick={() => setSelectedArticle(article)}>
                                            <ListItemText primary={article.title} />
                                        </ListItemButton>
                                    ))}
                                </List>
                            </Box>
                        )}
                    </Box>
                </Panel>
                <StyledResizeHandle />
                <Panel defaultSize={60} minSize={30}>
                    <Box sx={{ p: 2, height: '100%', overflowY: 'auto' }}>
                        {selectedArticle ? (
                            <Paper variant="outlined" sx={{ p: 2, backgroundColor: 'transparent' }}>
                                <Typography variant="h5" gutterBottom component="a" href={selectedArticle.link} target="_blank">{selectedArticle.title}</Typography>
                                <Typography variant="body2" sx={{ whiteSpace: 'pre-wrap' }}>
                                    {selectedArticle.content || "Kein Inhalt extrahiert."}
                                </Typography>
                            </Paper>
                        ) : (
                            <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', color: 'text.secondary' }}>
                                <Typography>Wählen Sie einen Artikel aus, um den Inhalt zu sehen.</Typography>
                            </Box>
                        )}
                    </Box>
                </Panel>
            </PanelGroup>
        </Box>
    );
}
