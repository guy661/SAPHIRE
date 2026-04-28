import { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { 
    Box, Typography, Button, Paper, FormControl, FormLabel, RadioGroup, 
    FormControlLabel, Radio, Switch, CircularProgress, Alert 
} from '@mui/material';
import { getDashboardById, updateDashboardSettings } from '../services/api';

export default function DashboardSettingsPage() {
    const { dashboardId } = useParams<{ dashboardId: string }>();
    const navigate = useNavigate();
    
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState<string | null>(null);

    // Settings State
    const [summaryStyle, setSummaryStyle] = useState('detailed');
    const [isActive, setIsActive] = useState(true);

    useEffect(() => {
        if (!dashboardId) return;
        setLoading(true);
        getDashboardById(dashboardId)
            .then(dashboard => {
                setSummaryStyle(dashboard.summary_style || 'detailed');
                setIsActive(dashboard.is_active !== false); // Default to true if undefined
            })
            .catch(err => {
                console.error('Failed to load dashboard:', err);
                setError('Dashboard konnte nicht geladen werden.');
            })
            .finally(() => setLoading(false));
    }, [dashboardId]);

    const handleSave = async () => {
        if (!dashboardId) return;
        setSaving(true);
        setError(null);

        try {
            await updateDashboardSettings(dashboardId, {
                summary_style: summaryStyle,
                is_active: isActive
            });
            // Navigate to Dashboard Detail on success
            navigate(`/dashboard/${dashboardId}`);
        } catch (err) {
            console.error('Failed to save settings:', err);
            setError('Einstellungen konnten nicht gespeichert werden.');
            setSaving(false);
        }
    };

    if (loading) return <Box sx={{ display: 'flex', justifyContent: 'center', p: 4 }}><CircularProgress /></Box>;

    return (
        <Box sx={{ maxWidth: '600px', mx: 'auto', p: 3 }}>
            <Typography variant="h4" gutterBottom>Einstellungen für den Live-Feed</Typography>
            <Typography variant="body1" color="text.secondary" paragraph>
                Passen Sie an, wie Sie informiert werden möchten. Der Feed aktualisiert sich automatisch in Echtzeit.
            </Typography>

            {error && <Alert severity="error" sx={{ mb: 2 }}>{error}</Alert>}

            <Paper sx={{ p: 3, mb: 3 }}>
                <FormControl component="fieldset" fullWidth sx={{ mb: 4 }}>
                    <FormLabel component="legend" sx={{ mb: 1, fontWeight: 'bold' }}>Länge der Micro-Zusammenfassungen</FormLabel>
                    <RadioGroup
                        value={summaryStyle}
                        onChange={(e) => setSummaryStyle(e.target.value)}
                    >
                        <FormControlLabel value="brief" control={<Radio />} label="Kurz & Bündig (Nur wichtigste Fakten)" />
                        <FormControlLabel value="balanced" control={<Radio />} label="Ausgewogen (Standard)" />
                        <FormControlLabel value="detailed" control={<Radio />} label="Detailliert (Hintergründe & Analysen)" />
                    </RadioGroup>
                </FormControl>

                <FormControl component="fieldset" fullWidth>
                    <FormLabel component="legend" sx={{ mb: 1, fontWeight: 'bold' }}>Live-Feed Status</FormLabel>
                    <FormControlLabel
                        control={
                            <Switch 
                                checked={isActive} 
                                onChange={(e) => setIsActive(e.target.checked)} 
                            />
                        }
                        label={isActive ? "Aktiv (Sucht im Hintergrund nach News)" : "Pausiert"}
                    />
                </FormControl>
            </Paper>

            <Button 
                variant="contained" 
                fullWidth 
                size="large" 
                onClick={handleSave} 
                disabled={saving}
            >
                {saving ? <CircularProgress size={24} color="inherit" /> : 'Speichern & Zurück'}
            </Button>
        </Box>
    );
}
