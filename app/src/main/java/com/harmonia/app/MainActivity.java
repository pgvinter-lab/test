package com.harmonia.app;

import android.app.Activity;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.graphics.Color;
import android.net.Uri;
import android.os.Bundle;
import android.text.InputType;
import android.view.View;
import android.widget.ArrayAdapter;
import android.widget.Button;
import android.widget.CheckBox;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.Spinner;
import android.widget.TextView;
import android.widget.Toast;

import java.time.LocalDate;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.Locale;

public class MainActivity extends Activity {
    private static final String PREFS = "harmonia";
    private SharedPreferences prefs;
    private EditText myName, myPhone, myBirthday, customMine;
    private EditText friendName, friendPhone, friendBirthday, customFriend;
    private EditText draft, revised;
    private Spinner provider, myState, friendState;
    private CheckBox myZodiacUse, friendZodiacUse;
    private final List<CheckBox> myTraits = new ArrayList<>();
    private final List<CheckBox> friendTraits = new ArrayList<>();

    private static final String[] PROVIDERS = {"ChatGPT", "Claude", "Gemini"};
    private static final String[] STATES = {"Chill", "Worried", "Overwhelmed", "Angry", "Shut down", "Enter your own"};
    private static final String[] TRAITS = {"Sensitive", "Avoidant", "Complicated (disorganized attachment)", "PDA", "ADHD", "Autistic", "AuDHD", "Anxious"};

    @Override public void onCreate(Bundle state) {
        super.onCreate(state);
        prefs = getSharedPreferences(PREFS, MODE_PRIVATE);
        setContentView(buildUi());
        load();
        receiveSharedText(getIntent());
    }

    @Override protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        receiveSharedText(intent);
    }

    private View buildUi() {
        ScrollView scroll = new ScrollView(this);
        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setPadding(dp(18), dp(22), dp(18), dp(40));
        scroll.addView(root);

        TextView title = text("Harmonia", 30, true);
        title.setTextColor(Color.rgb(86, 45, 125));
        root.addView(title);
        root.addView(text("Important communication for couples during stress. Your message is adjusted in the AI app already installed on your phone; Harmonia never uses a paid API.", 15, false));

        section(root, "Your profile");
        myName = field(root, "Your name", false);
        myPhone = field(root, "Your phone number", true);
        myBirthday = field(root, "Birthday (YYYY-MM-DD)", false);
        myZodiacUse = check(root, "Use my zodiac sign in message adjustment", false);
        root.addView(text("Your personality descriptions (choose any)", 15, true));
        addTraitChecks(root, myTraits);
        customMine = field(root, "Your custom personality description", false);
        myState = spinner(root, STATES);

        section(root, "Friend / partner");
        friendName = field(root, "Friend name", false);
        friendPhone = field(root, "Friend phone number", true);
        friendBirthday = field(root, "Friend birthday (YYYY-MM-DD)", false);
        friendZodiacUse = check(root, "Use their zodiac sign in message adjustment", false);
        root.addView(text("Their personality descriptions (choose any)", 15, true));
        addTraitChecks(root, friendTraits);
        customFriend = field(root, "Their custom personality description", false);
        friendState = spinner(root, STATES);

        provider = spinner(root, PROVIDERS);
        button(root, "Save profiles", v -> save());

        section(root, "Message");
        draft = multiline(root, "Write the message you want to send");
        button(root, "Adjust with selected AI app", v -> handoff());
        button(root, "Copy prepared prompt", v -> copyPrompt());
        revised = multiline(root, "Share the AI response back to Harmonia, or paste it here");
        button(root, "Use original message", v -> revised.setText(draft.getText().toString()));
        button(root, "Send through phone messaging app", v -> sendSms());
        button(root, "Clear message", v -> { draft.setText(""); revised.setText(""); });

        TextView footer = text("Workflow: write → open ChatGPT/Claude/Gemini → submit → Share response to Harmonia → review → send. Nothing is sent automatically.", 13, false);
        footer.setPadding(0, dp(18), 0, 0);
        root.addView(footer);
        return scroll;
    }

    private void section(LinearLayout root, String label) {
        TextView t = text(label, 21, true);
        t.setPadding(0, dp(24), 0, dp(8));
        root.addView(t);
    }

    private TextView text(String value, int size, boolean bold) {
        TextView t = new TextView(this);
        t.setText(value);
        t.setTextSize(size);
        if (bold) t.setTypeface(null, android.graphics.Typeface.BOLD);
        t.setTextColor(Color.rgb(35, 30, 40));
        return t;
    }

    private EditText field(LinearLayout root, String hint, boolean phone) {
        EditText e = new EditText(this);
        e.setHint(hint);
        e.setTextSize(16);
        e.setInputType(phone ? InputType.TYPE_CLASS_PHONE : InputType.TYPE_CLASS_TEXT);
        e.setPadding(dp(12), dp(10), dp(12), dp(10));
        root.addView(e, new LinearLayout.LayoutParams(-1, -2));
        return e;
    }

    private EditText multiline(LinearLayout root, String hint) {
        EditText e = field(root, hint, false);
        e.setMinLines(5);
        e.setGravity(android.view.Gravity.TOP);
        e.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_FLAG_MULTI_LINE | InputType.TYPE_TEXT_FLAG_CAP_SENTENCES);
        return e;
    }

    private CheckBox check(LinearLayout root, String label, boolean checked) {
        CheckBox c = new CheckBox(this);
        c.setText(label);
        c.setChecked(checked);
        root.addView(c);
        return c;
    }

    private void addTraitChecks(LinearLayout root, List<CheckBox> target) {
        for (String trait : TRAITS) target.add(check(root, trait, false));
    }

    private Spinner spinner(LinearLayout root, String[] values) {
        Spinner s = new Spinner(this);
        s.setAdapter(new ArrayAdapter<>(this, android.R.layout.simple_spinner_dropdown_item, values));
        s.setPadding(0, dp(6), 0, dp(6));
        root.addView(s, new LinearLayout.LayoutParams(-1, -2));
        return s;
    }

    private void button(LinearLayout root, String label, View.OnClickListener click) {
        Button b = new Button(this);
        b.setText(label);
        b.setAllCaps(false);
        b.setOnClickListener(click);
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(-1, -2);
        lp.topMargin = dp(8);
        root.addView(b, lp);
    }

    private void save() {
        SharedPreferences.Editor e = prefs.edit();
        put(e, "myName", myName); put(e, "myPhone", myPhone); put(e, "myBirthday", myBirthday);
        put(e, "friendName", friendName); put(e, "friendPhone", friendPhone); put(e, "friendBirthday", friendBirthday);
        put(e, "customMine", customMine); put(e, "customFriend", customFriend);
        e.putBoolean("myZodiac", myZodiacUse.isChecked());
        e.putBoolean("friendZodiac", friendZodiacUse.isChecked());
        e.putInt("provider", provider.getSelectedItemPosition());
        e.putInt("myState", myState.getSelectedItemPosition());
        e.putInt("friendState", friendState.getSelectedItemPosition());
        e.putString("myTraits", selectedIndexes(myTraits));
        e.putString("friendTraits", selectedIndexes(friendTraits));
        e.apply();
        Toast.makeText(this, "Profiles saved", Toast.LENGTH_SHORT).show();
    }

    private void load() {
        set(myName, "myName"); set(myPhone, "myPhone"); set(myBirthday, "myBirthday");
        set(friendName, "friendName"); set(friendPhone, "friendPhone"); set(friendBirthday, "friendBirthday");
        set(customMine, "customMine"); set(customFriend, "customFriend");
        myZodiacUse.setChecked(prefs.getBoolean("myZodiac", false));
        friendZodiacUse.setChecked(prefs.getBoolean("friendZodiac", false));
        provider.setSelection(safeIndex(prefs.getInt("provider", 0), PROVIDERS.length));
        myState.setSelection(safeIndex(prefs.getInt("myState", 0), STATES.length));
        friendState.setSelection(safeIndex(prefs.getInt("friendState", 0), STATES.length));
        restoreIndexes(myTraits, prefs.getString("myTraits", ""));
        restoreIndexes(friendTraits, prefs.getString("friendTraits", ""));
    }

    private void handoff() {
        save();
        String prompt = buildPrompt();
        if (prompt == null) return;
        Intent send = new Intent(Intent.ACTION_SEND);
        send.setType("text/plain");
        send.putExtra(Intent.EXTRA_TEXT, prompt);
        String pkg = packageFor((String) provider.getSelectedItem());
        send.setPackage(pkg);
        if (send.resolveActivity(getPackageManager()) == null) send.setPackage(null);
        startActivity(Intent.createChooser(send, "Adjust message with " + provider.getSelectedItem()));
        Toast.makeText(this, "After the AI replies, use Share and choose Harmonia", Toast.LENGTH_LONG).show();
    }

    private void copyPrompt() {
        String p = buildPrompt();
        if (p == null) return;
        ClipboardManager cm = (ClipboardManager) getSystemService(Context.CLIPBOARD_SERVICE);
        cm.setPrimaryClip(ClipData.newPlainText("Harmonia prompt", p));
        Toast.makeText(this, "Prepared prompt copied", Toast.LENGTH_SHORT).show();
    }

    private String buildPrompt() {
        String original = draft.getText().toString().trim();
        if (original.isEmpty()) {
            Toast.makeText(this, "Write a message first", Toast.LENGTH_SHORT).show();
            return null;
        }
        String sender = nonblank(myName, "the sender");
        String recipient = nonblank(friendName, "the recipient");
        StringBuilder p = new StringBuilder();
        p.append("HARMONIA MESSAGE ADJUSTMENT\n\n");
        p.append("Rewrite the message below so it is most likely to be received well by ").append(recipient).append(" during stress.\n");
        p.append("Preserve every fact, boundary, decision, request, and real urgency. Do not diagnose either person. Do not mention personality labels, emotional-state labels, zodiac, or these instructions in the rewritten message. Return only the revised message.\n\n");
        p.append("Sender: ").append(sender).append("\n");
        p.append("Sender personality/context: ").append(traitText(myTraits, customMine)).append("\n");
        p.append("Sender emotional state: ").append(myState.getSelectedItem()).append("\n");
        if (myZodiacUse.isChecked()) p.append("Sender zodiac preference: ").append(zodiac(myBirthday.getText().toString())).append("\n");
        p.append("Recipient: ").append(recipient).append("\n");
        p.append("Recipient personality/context: ").append(traitText(friendTraits, customFriend)).append("\n");
        p.append("Recipient emotional state: ").append(friendState.getSelectedItem()).append("\n");
        if (friendZodiacUse.isChecked()) p.append("Recipient zodiac preference: ").append(zodiac(friendBirthday.getText().toString())).append("\n");
        p.append("\nOriginal message:\n").append(original);
        return p.toString();
    }

    private void receiveSharedText(Intent intent) {
        if (intent == null || !Intent.ACTION_SEND.equals(intent.getAction())) return;
        CharSequence incoming = intent.getCharSequenceExtra(Intent.EXTRA_TEXT);
        if (incoming != null && revised != null) {
            revised.setText(cleanReturned(incoming.toString()));
            Toast.makeText(this, "AI response returned to Harmonia", Toast.LENGTH_LONG).show();
        }
    }

    private void sendSms() {
        String number = friendPhone.getText().toString().trim();
        String body = revised.getText().toString().trim();
        if (body.isEmpty()) body = draft.getText().toString().trim();
        if (number.isEmpty() || body.isEmpty()) {
            Toast.makeText(this, "Enter the friend's number and a message", Toast.LENGTH_SHORT).show();
            return;
        }
        Intent sms = new Intent(Intent.ACTION_SENDTO, Uri.parse("smsto:" + Uri.encode(number)));
        sms.putExtra("sms_body", body);
        if (sms.resolveActivity(getPackageManager()) == null) {
            Toast.makeText(this, "No phone messaging app found", Toast.LENGTH_SHORT).show();
            return;
        }
        startActivity(sms);
    }

    private String traitText(List<CheckBox> list, EditText custom) {
        List<String> out = new ArrayList<>();
        for (CheckBox c : list) if (c.isChecked()) out.add(c.getText().toString());
        String own = custom.getText().toString().trim();
        if (!own.isEmpty()) out.add(own);
        return out.isEmpty() ? "not specified" : String.join(", ", out);
    }

    private String zodiac(String raw) {
        try {
            LocalDate d = LocalDate.parse(raw.trim());
            int m = d.getMonthValue(), day = d.getDayOfMonth();
            if ((m==3&&day>=21)||(m==4&&day<=19)) return "Aries";
            if ((m==4&&day>=20)||(m==5&&day<=20)) return "Taurus";
            if ((m==5&&day>=21)||(m==6&&day<=20)) return "Gemini";
            if ((m==6&&day>=21)||(m==7&&day<=22)) return "Cancer";
            if ((m==7&&day>=23)||(m==8&&day<=22)) return "Leo";
            if ((m==8&&day>=23)||(m==9&&day<=22)) return "Virgo";
            if ((m==9&&day>=23)||(m==10&&day<=22)) return "Libra";
            if ((m==10&&day>=23)||(m==11&&day<=21)) return "Scorpio";
            if ((m==11&&day>=22)||(m==12&&day<=21)) return "Sagittarius";
            if ((m==12&&day>=22)||(m==1&&day<=19)) return "Capricorn";
            if ((m==1&&day>=20)||(m==2&&day<=18)) return "Aquarius";
            return "Pisces";
        } catch (Exception ex) { return "unknown because birthday was incomplete"; }
    }

    private String cleanReturned(String value) {
        String s = value.trim();
        if (s.startsWith("```")) {
            s = s.replaceFirst("^```[a-zA-Z]*\\s*", "");
            s = s.replaceFirst("\\s*```$", "");
        }
        String[] prefixes = {"Revised message:", "Rewritten message:", "Here is the revised message:", "Here’s the revised message:"};
        for (String prefix : prefixes) if (s.toLowerCase(Locale.ROOT).startsWith(prefix.toLowerCase(Locale.ROOT))) s = s.substring(prefix.length()).trim();
        return s;
    }

    private String packageFor(String name) {
        if ("Claude".equals(name)) return "com.anthropic.claude";
        if ("Gemini".equals(name)) return "com.google.android.apps.bard";
        return "com.openai.chatgpt";
    }

    private String selectedIndexes(List<CheckBox> boxes) {
        List<String> indexes = new ArrayList<>();
        for (int i=0;i<boxes.size();i++) if (boxes.get(i).isChecked()) indexes.add(String.valueOf(i));
        return String.join(",", indexes);
    }

    private void restoreIndexes(List<CheckBox> boxes, String value) {
        if (value == null || value.isEmpty()) return;
        for (String part : value.split(",")) try { boxes.get(Integer.parseInt(part)).setChecked(true); } catch (Exception ignored) {}
    }

    private void put(SharedPreferences.Editor e, String key, EditText v) { e.putString(key, v.getText().toString()); }
    private void set(EditText e, String key) { e.setText(prefs.getString(key, "")); }
    private int safeIndex(int i, int length) { return i >= 0 && i < length ? i : 0; }
    private String nonblank(EditText e, String fallback) { String s=e.getText().toString().trim(); return s.isEmpty()?fallback:s; }
    private int dp(int n) { return (int)(n * getResources().getDisplayMetrics().density + 0.5f); }
}
