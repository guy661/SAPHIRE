import { useParams, Link as RouterLink, useNavigate } from 'react-router-dom';
import { Box, TextField, Button, Paper, List, ListItem, ListItemText, Typography, Container, CircularProgress } from '@mui/material';
import { useState } from 'react';
import { runPersonalizationChat } from '../services/api';

interface Message {
    sender: 'user' | 'model';
    text: string;
}

export default function ChatPage() {
    const { dashboardId } = useParams<{ dashboardId: string }>();
    const navigate = useNavigate();
    const [messages, setMessages] = useState<Message[]>([
        { sender: 'model', text: 'Worum soll es in diesem Dashboard gehen? Beschreiben Sie Ihr Interessensgebiet.' },
    ]);
    const [input, setInput] = useState('');
    const [isLoading, setIsLoading] = useState(false);

    const handleSend = async () => {
        if (input.trim() && dashboardId && !isLoading) {
            const userMessage: Message = { sender: 'user', text: input };
            setMessages(prev => [...prev, userMessage]);
            setInput('');
            setIsLoading(true);

            try {
                // Note: The backend personalization chat manages its own history via session.
                // We send only the current message.
                const response = await runPersonalizationChat(dashboardId, input);
                const modelMessage: Message = { sender: 'model', text: response.message };
                setMessages(prev => [...prev, modelMessage]);

                // If the backend indicates the process is done, navigate back to the main dashboard page
                if (response.isDone) {
                    setTimeout(() => navigate('/'), 2000);
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
                                <ListItemText primary={msg.text} />
                            </Paper>
                        </ListItem>
                    ))}
                    {isLoading && <ListItem sx={{justifyContent: 'flex-start'}}><CircularProgress size={24} /></ListItem>}
                </List>

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
            </Paper>
        </Container>
    );
}
