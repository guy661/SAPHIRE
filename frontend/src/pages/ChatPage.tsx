import { useParams, Link as RouterLink, useNavigate, useLocation } from 'react-router-dom';
import { Box, TextField, Button, Paper, List, ListItem, ListItemText, Typography, Container, CircularProgress } from '@mui/material';
import { useState } from 'react';
import { runPersonalizationChat, updateDashboardSettings } from '../services/api';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useEmbedding } from '../hooks/useEmbedding';

interface Message {
    sender: 'user' | 'model';
    text: string;
}

export default function ChatPage() {
    const { dashboardId } = useParams<{ dashboardId: string }>();
    const navigate = useNavigate();
    const location = useLocation();
    const { generateEmbedding } = useEmbedding();
    
    const [messages, setMessages] = useState<Message[]>([
        { sender: 'model', text: 'Worum soll es in diesem Dashboard gehen? Beschreiben Sie Ihr Interessensgebiet.' },
    ]);
    const [input, setInput] = useState('');
    const [isLoading, setIsLoading] = useState(false);
    const [isFinished, setIsFinished] = useState(false);
    const [isEmbedding, setIsEmbedding] = useState(false);

    const handleSend = async () => {
        if (input.trim() && dashboardId && !isLoading) {
            const userMessage: Message = { sender: 'user', text: input };
            setMessages(prev => [...prev, userMessage]);
            setInput('');
            setIsLoading(true);

            try {
                const response = await runPersonalizationChat(dashboardId, input);
                const modelMessage: Message = { sender: 'model', text: response.message };
                setMessages(prev => [...prev, modelMessage]);

                if (response.isDone) {
                    setIsFinished(true);
                    
                    // --- NEW: Generate Embedding in Frontend ---
                    if (response.user_intent) {
                        setIsEmbedding(true);
                        try {
                            const embedding = await generateEmbedding(response.user_intent);
                            await updateDashboardSettings(dashboardId, {
                                user_intent_embedding: embedding
                            });
                            console.log('Embedding successfully saved to backend.');
                        } catch (embErr) {
                            console.error('Failed to generate/save embedding:', embErr);
                        } finally {
                            setIsEmbedding(false);
                        }
                    }
                }

            } catch (error) {
                console.error("Chat API error:", error);
                const errorMessage: Message = { sender: 'model', text: 'Entschuldigung, ein Fehler ist aufgetreten.' };
                setMessages(prev => [...prev, errorMessage]);
            } finally {
                setIsLoading(false);
            }
        }
    };

    const handleContinue = () => {
        const params = new URLSearchParams(location.search);
        const isOnboarding = params.get('onboarding') === 'true';
        
        if (isOnboarding) {
            navigate(`/dashboard/${dashboardId}/settings`);
        } else {
            navigate(`/dashboard/${dashboardId}`);
        }
    };

    return (
        <Container maxWidth="md" sx={{ mt: 4 }}>
             <Box sx={{ mb: 4 }}>
                <Button component={RouterLink} to="/">
                    &larr; Zurück zu allen Dashboards
                </Button>
            </Box>

            <Typography variant="h4" gutterBottom>Thema für Dashboard #{dashboardId} festlegen</Typography>

            <Paper elevation={3} sx={{ height: '60vh', display: 'flex', flexDirection: 'column' }}>
                <List sx={{ flexGrow: 1, overflow: 'auto', p: 2 }}>
                    {messages.map((msg, index) => (
                        <ListItem key={index} sx={{ 
                            justifyContent: msg.sender === 'user' ? 'flex-end' : 'flex-start'
                        }}>
                            <Paper 
                                elevation={1} 
                                sx={{ 
                                    p: 1.5,
                                    bgcolor: msg.sender === 'user' ? 'primary.main' : 'background.paper',
                                    color: msg.sender === 'user' ? 'primary.contrastText' : 'text.primary',
                                    maxWidth: '70%'
                                }}
                            >
                                {msg.sender === 'model' ? (
                                    <ReactMarkdown remarkPlugins={[remarkGfm]}>
                                        {msg.text}
                                    </ReactMarkdown>
                                ) : (
                                    <ListItemText primary={msg.text} />
                                )}
                            </Paper>
                        </ListItem>
                    ))}
                    {isLoading && <ListItem sx={{justifyContent: 'flex-start'}}><CircularProgress size={24} /></ListItem>}
                    {isEmbedding && (
                        <ListItem sx={{justifyContent: 'flex-start'}}>
                            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                                <CircularProgress size={16} />
                                <Typography variant="caption" color="text.secondary">
                                    KI-Modell wird geladen & Thema wird vektorisiert...
                                </Typography>
                            </Box>
                        </ListItem>
                    )}
                </List>

                {!isFinished ? (
                    <Box sx={{ p: 2, display: 'flex', borderTop: '1px solid', borderColor: 'divider' }}>
                        <TextField
                            fullWidth
                            variant="outlined"
                            placeholder="Ihre Antwort..."
                            value={input}
                            onChange={(e) => setInput(e.target.value)}
                            onKeyPress={(e) => e.key === 'Enter' && handleSend()}
                            disabled={isLoading}
                        />
                        <Button variant="contained" onClick={handleSend} sx={{ ml: 2 }} disabled={isLoading}>
                            Senden
                        </Button>
                    </Box>
                ) : (
                    <Box sx={{ p: 2, display: 'flex', justifyContent: 'center', borderTop: '1px solid', borderColor: 'divider', bgcolor: 'action.hover' }}>
                        <Button variant="contained" color="success" size="large" onClick={handleContinue}>
                            Weiter zum Dashboard
                        </Button>
                    </Box>
                )}
            </Paper>
        </Container>
    );
}
