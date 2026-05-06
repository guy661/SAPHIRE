import { useState, useEffect } from 'react';
import { Box, Typography, TextField, Button, Paper, Alert, CircularProgress } from '@mui/material';
import { useAuth } from '../context/AuthContext';

export default function UserSettingsPage() {
    const { user, updateEmail } = useAuth();
    const [email, setEmail] = useState(user?.email || '');
    const [saving, setSaving] = useState(false);
    const [message, setMessage] = useState<{ type: 'success' | 'error', text: string } | null>(null);

    useEffect(() => {
        if (user?.email) {
            setEmail(user.email);
        }
    }, [user]);

    const handleSave = async () => {
        setSaving(true);
        setMessage(null);
        try {
            await updateEmail(email);
            setMessage({ type: 'success', text: 'E-Mail Adresse erfolgreich aktualisiert!' });
        } catch (err) {
            setMessage({ type: 'error', text: 'Fehler beim Aktualisieren der E-Mail Adresse.' });
        } finally {
            setSaving(false);
        }
    };

    return (
        <Box sx={{ maxWidth: '600px', mx: 'auto', p: 3 }}>
            <Typography variant="h4" gutterBottom>Konto-Einstellungen</Typography>
            <Typography variant="body1" color="text.secondary" paragraph>
                Verwalten Sie Ihre persönlichen Daten und Benachrichtigungseinstellungen.
            </Typography>

            <Paper sx={{ p: 3, mb: 3 }}>
                <Typography variant="h6" gutterBottom>E-Mail Benachrichtigungen</Typography>
                <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
                    Geben Sie Ihre E-Mail Adresse an, um das tägliche Morning Briefing (7:00 Uhr) und Sofort-Alarme zu erhalten.
                </Typography>

                {message && (
                    <Alert severity={message.type} sx={{ mb: 2 }}>{message.text}</Alert>
                )}

                <TextField
                    fullWidth
                    label="E-Mail Adresse"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="deine@email.de"
                    margin="normal"
                />

                <Button 
                    variant="contained" 
                    sx={{ mt: 2 }}
                    onClick={handleSave}
                    disabled={saving || !email}
                >
                    {saving ? <CircularProgress size={24} /> : 'Speichern'}
                </Button>
            </Paper>

            <Paper sx={{ p: 3, bgcolor: '#f5f5f5' }}>
                <Typography variant="h6" gutterBottom color="text.secondary">Info zum Briefing</Typography>
                <Typography variant="body2" color="text.secondary">
                    Standardmäßig erhalten Sie jeden Morgen um 07:00 Uhr eine Zusammenfassung aller neuen Artikel. 
                    Wenn Sie in Ihren Dashboards "Kill-Keywords" festgelegt haben, erhalten Sie dafür sofort eine Benachrichtigung.
                </Typography>
            </Paper>
        </Box>
    );
}
