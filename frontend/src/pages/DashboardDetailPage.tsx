import React, { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { getDashboardById, getDashboardArticles, API_BASE_URL, summarizeArticle } from '../services/api';
import { 
    Box, Typography, CircularProgress, Alert, Paper, Link, Chip, IconButton, Button, Skeleton
} from '@mui/material';
import { ArrowLeft, Gear, MagicWand } from '@phosphor-icons/react';
import { motion, AnimatePresence } from 'framer-motion';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

const markdownComponents = {
    h1: ({...props}) => <Typography variant="h6" component="h1" gutterBottom {...props} />,
    h2: ({...props}) => <Typography variant="subtitle1" component="h2" gutterBottom {...props} />,
    h3: ({...props}) => <Typography variant="subtitle2" component="h3" gutterBottom {...props} />,
    p: ({...props}) => <Typography variant="body2" paragraph sx={{ lineHeight: 1.5, mb: 1 }} {...props} />,
    a: ({...props}) => <Link {...props} target="_blank" rel="noopener noreferrer" />,
    li: ({...props}) => <li style={{marginBottom: '4px'}}><Typography variant="body2" component="span" {...props} /></li>
};

export default function DashboardDetailPage() {
    const { id } = useParams<{ id: string }>();
    const navigate = useNavigate();
    
    const [dashboard, setDashboard] = useState<any>(null);
    const [articles, setArticles] = useState<any[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [isStreaming, setIsStreaming] = useState(false);
    const [summarizingIds, setSummarizingIds] = useState<Set<string>>(new Set());

    const handleSummarize = async (articleId: string) => {
        if (summarizingIds.has(articleId)) return;
        
        setSummarizingIds(prev => new Set(prev).add(articleId));
        try {
            const data = await summarizeArticle(articleId);
            setArticles(prev => prev.map(art => 
                art.id === articleId ? { ...art, micro_summary: data.summary } : art
            ));
        } catch (err: any) {
            console.error("Summarization failed:", err);
        } finally {
            setSummarizingIds(prev => {
                const next = new Set(prev);
                next.delete(articleId);
                return next;
            });
        }
    };

    useEffect(() => {
        if (!id) return;
        
        let eventSource: EventSource | null = null;

        const loadInitialData = async () => {
            try {
                setLoading(true);
                const dashData = await getDashboardById(id);
                setDashboard(dashData);

                const articlesData = await getDashboardArticles(id);
                setArticles(articlesData);
                setError(null);
            } catch (err: any) {
                console.error("Failed to load dashboard data:", err);
                setError(err.message || 'Laden fehlgeschlagen');
            } finally {
                setLoading(false);
            }
        };

        const setupSSE = () => {
            eventSource = new EventSource(`${API_BASE_URL}/dashboards/${id}/stream`, {
                withCredentials: true
            });

            eventSource.onopen = () => {
                console.log("SSE Connection opened.");
                setIsStreaming(true);
            };

            eventSource.onmessage = (event) => {
                if (event.data === 'heartbeat') return;
                
                try {
                    const newArticles = JSON.parse(event.data);
                    if (newArticles.length > 0) {
                        setArticles(prev => {
                            // Merge new articles, avoiding duplicates
                            const existingIds = new Set(prev.map(a => a.id));
                            const uniqueNew = newArticles.filter((a: any) => !existingIds.has(a.id));
                            return [...uniqueNew, ...prev];
                        });
                    }
                } catch (e) {
                    console.error("Error parsing SSE data:", e);
                }
            };

            eventSource.onerror = (err) => {
                console.error("SSE Error:", err);
                setIsStreaming(false);
                eventSource?.close();
                // Simple reconnect logic after 5 seconds
                setTimeout(setupSSE, 5000);
            };
        };

        loadInitialData().then(() => {
            setupSSE();
        });

        return () => {
            if (eventSource) {
                eventSource.close();
            }
        };
    }, [id]);

    if (loading) {
        return (
            <Box display="flex" justifyContent="center" alignItems="center" minHeight="50vh">
                <CircularProgress />
            </Box>
        );
    }

    if (error || !dashboard) {
        return (
            <Box p={3}>
                <Alert severity="error">{error || 'Dashboard nicht gefunden.'}</Alert>
                <Button sx={{ mt: 2 }} onClick={() => navigate('/')} startIcon={<ArrowLeft />}>
                    Zurück zur Übersicht
                </Button>
            </Box>
        );
    }

    return (
        <Box sx={{ maxWidth: '800px', mx: 'auto', p: { xs: 2, md: 4 } }}>
            {/* Header */}
            <Box display="flex" justifyContent="space-between" alignItems="center" mb={4}>
                <Box display="flex" alignItems="center" gap={2}>
                    <IconButton onClick={() => navigate('/')} size="small" sx={{ bgcolor: 'background.paper', boxShadow: 1 }}>
                        <ArrowLeft />
                    </IconButton>
                    <Box>
                        <Typography variant="h4" fontWeight={700}>
                            {dashboard.name}
                        </Typography>
                        <Typography variant="body2" color="text.secondary" sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                            Live-Feed
                            {isStreaming && (
                                <Box component="span" sx={{
                                    width: 8, height: 8, borderRadius: '50%', bgcolor: 'success.main',
                                    animation: 'pulse 1.5s infinite',
                                    '@keyframes pulse': {
                                        '0%': { transform: 'scale(0.95)', boxShadow: '0 0 0 0 rgba(46, 125, 50, 0.7)' },
                                        '70%': { transform: 'scale(1)', boxShadow: '0 0 0 6px rgba(46, 125, 50, 0)' },
                                        '100%': { transform: 'scale(0.95)', boxShadow: '0 0 0 0 rgba(46, 125, 50, 0)' }
                                    }
                                }} />
                            )}
                        </Typography>
                    </Box>
                </Box>
                
                <IconButton onClick={() => navigate(`/dashboard/${id}/settings`)} sx={{ bgcolor: 'background.paper', boxShadow: 1 }}>
                    <Gear />
                </IconButton>
            </Box>

            {/* Content Feed */}
            {articles.length === 0 ? (
                <Paper sx={{ p: 4, textAlign: 'center', bgcolor: 'background.paper' }}>
                    <Typography variant="h6" color="text.secondary" mb={2}>
                        Noch keine Artikel gefunden.
                    </Typography>
                    <Typography variant="body2" color="text.secondary">
                        Der Live-Feed ist aktiv. Sobald neue Nachrichten zu deinem Thema gefunden werden, tauchen sie hier automatisch auf.
                    </Typography>
                </Paper>
            ) : (
                <Box display="flex" flexDirection="column" gap={3}>
                    <AnimatePresence>
                        {articles.map((article, index) => (
                            <motion.div
                                key={article.id}
                                initial={{ opacity: 0, y: -20, scale: 0.95 }}
                                animate={{ opacity: 1, y: 0, scale: 1 }}
                                transition={{ duration: 0.4, delay: index < 5 ? index * 0.1 : 0 }}
                            >
                                <Paper 
                                    elevation={0}
                                    sx={{ 
                                        p: 3, 
                                        borderRadius: 3,
                                        border: '1px solid',
                                        borderColor: 'divider',
                                        bgcolor: 'background.paper',
                                        transition: 'transform 0.2s ease, box-shadow 0.2s ease',
                                        '&:hover': {
                                            transform: 'translateY(-4px)',
                                            boxShadow: 4,
                                        }
                                    }}
                                >
                                    <Box display="flex" justifyContent="space-between" alignItems="flex-start" mb={1}>
                                        <Typography variant="caption" color="primary.main" fontWeight={600} sx={{ textTransform: 'uppercase', letterSpacing: 1 }}>
                                            {article.source_name}
                                        </Typography>
                                        <Typography variant="caption" color="text.secondary">
                                            {new Date(article.pub_date || article.created_at).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' })} Uhr
                                        </Typography>
                                    </Box>
                                    
                                    <Link href={article.link} target="_blank" rel="noopener noreferrer" underline="hover" color="inherit">
                                        <Typography variant="h6" component="h2" fontWeight={700} mb={1}>
                                            {article.title}
                                        </Typography>
                                    </Link>

                                    {/* AI Selection Reason (Subtle) */}
                                    {article.relevance_reason && (
                                        <Typography variant="caption" sx={{ 
                                            display: 'block', 
                                            mb: 1, 
                                            fontStyle: 'italic', 
                                            color: 'text.secondary',
                                            bgcolor: 'rgba(25, 118, 210, 0.05)',
                                            p: 1,
                                            borderRadius: 1,
                                            borderLeft: '3px solid',
                                            borderColor: 'primary.light'
                                        }}>
                                            <b>KI-Begründung:</b> {article.relevance_reason}
                                        </Typography>
                                    )}

                                    {article.micro_summary ? (
                                        <Box sx={{ mt: 2, p: 2, bgcolor: 'action.hover', borderRadius: 2 }}>
                                            <ReactMarkdown 
                                                remarkPlugins={[remarkGfm]} 
                                                components={markdownComponents}
                                            >
                                                {article.micro_summary}
                                            </ReactMarkdown>
                                        </Box>
                                    ) : (
                                        <Box sx={{ mt: 2 }}>
                                            {summarizingIds.has(article.id) ? (
                                                <Box sx={{ p: 2, bgcolor: 'action.hover', borderRadius: 2 }}>
                                                    <Skeleton variant="text" />
                                                    <Skeleton variant="text" />
                                                    <Skeleton variant="text" width="60%" />
                                                </Box>
                                            ) : (
                                                <Button 
                                                    size="small" 
                                                    startIcon={<MagicWand />}
                                                    onClick={() => handleSummarize(article.id)}
                                                    sx={{ 
                                                        color: 'text.secondary',
                                                        '&:hover': { color: 'primary.main', bgcolor: 'primary.lighter' }
                                                    }}
                                                >
                                                    ✨ KI-Zusammenfassung laden
                                                </Button>
                                            )}
                                        </Box>
                                    )}
                                    
                                    <Box display="flex" justifyContent="flex-end" mt={2}>
                                        <Chip 
                                            label={`Relevanz: ${Math.round((article.relevance_score || 0) * 100)}%`} 
                                            size="small" 
                                            color="secondary" 
                                            variant="outlined" 
                                            sx={{ opacity: 0.8 }}
                                        />
                                    </Box>
                                </Paper>
                            </motion.div>
                        ))}
                    </AnimatePresence>
                </Box>
            )}
        </Box>
    );
}