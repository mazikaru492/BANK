import java.awt.BorderLayout;
import java.awt.Color;
import java.awt.Dimension;
import java.awt.Font;
import java.awt.GridBagConstraints;
import java.awt.GridBagLayout;
import java.awt.GridLayout;
import java.awt.Insets;
import java.math.BigDecimal;
import java.math.RoundingMode;
import java.time.LocalDateTime;
import java.time.format.DateTimeFormatter;

import javax.swing.BorderFactory;
import javax.swing.JButton;
import javax.swing.JFrame;
import javax.swing.JLabel;
import javax.swing.JOptionPane;
import javax.swing.JPanel;
import javax.swing.JPasswordField;
import javax.swing.JTabbedPane;
import javax.swing.JTextArea;
import javax.swing.JTextField;
import javax.swing.SwingConstants;
import javax.swing.SwingUtilities;

public class SimpleBankSystem extends JFrame {
    private static final String BANK_CODE = "003";
    private static final String BRANCH_CODE = "024";
    private static final String ACCOUNT_NUMBER = "1017256";
    private static final String PIN = "9314";
    private static final BigDecimal INITIAL_BALANCE = new BigDecimal("0.00");

    private BigDecimal balance = INITIAL_BALANCE;

    private static final Color PRIMARY_COLOR = new Color(30, 102, 180);
    private static final Color SUCCESS_COLOR = new Color(24, 130, 76);
    private static final Color ERROR_COLOR = new Color(190, 52, 52);
    private static final Color MUTED_COLOR = new Color(95, 106, 120);

    public SimpleBankSystem() {
        setTitle("\u9280\u884c\u30b7\u30b9\u30c6\u30e0");
        setDefaultCloseOperation(JFrame.EXIT_ON_CLOSE);
        setSize(500, 400);
        setMinimumSize(new Dimension(460, 360));
        setLocationRelativeTo(null);

        JPanel contentPanel = new JPanel(new BorderLayout(0, 16));
        contentPanel.setBorder(BorderFactory.createEmptyBorder(22, 28, 24, 28));
        contentPanel.setBackground(Color.WHITE);

        contentPanel.add(createHeaderPanel(), BorderLayout.NORTH);

        JTabbedPane tabbedPane = new JTabbedPane();
        tabbedPane.setFont(new Font(Font.SANS_SERIF, Font.PLAIN, 14));
        tabbedPane.addTab("\u6b8b\u9ad8\u7167\u4f1a", createBalancePanel());
        tabbedPane.addTab("\u5165\u91d1", createDepositPanel());
        tabbedPane.addTab("\u51fa\u91d1", createWithdrawalPanel());
        contentPanel.add(tabbedPane, BorderLayout.CENTER);

        setContentPane(contentPanel);
    }

    private JPanel createHeaderPanel() {
        JPanel headerPanel = new JPanel(new GridLayout(2, 1, 0, 4));
        headerPanel.setBackground(Color.WHITE);

        JLabel titleLabel = new JLabel("=== \u9280\u884c\u30b7\u30b9\u30c6\u30e0\u3078\u3088\u3046\u3053\u305d ===", SwingConstants.CENTER);
        titleLabel.setFont(new Font(Font.SANS_SERIF, Font.BOLD, 20));
        titleLabel.setForeground(new Color(35, 48, 65));

        JLabel accountLabel = new JLabel(
                "\u9280\u884c\u30b3\u30fc\u30c9: " + BANK_CODE + " | \u652f\u5e97\u30b3\u30fc\u30c9: " + BRANCH_CODE + " | \u53e3\u5ea7\u756a\u53f7: " + ACCOUNT_NUMBER,
                SwingConstants.CENTER);
        accountLabel.setFont(new Font(Font.SANS_SERIF, Font.PLAIN, 12));
        accountLabel.setForeground(MUTED_COLOR);

        headerPanel.add(titleLabel);
        headerPanel.add(accountLabel);
        return headerPanel;
    }

    private JPanel createBalancePanel() {
        JPanel panel = createFormPanel();
        GridBagConstraints constraints = createConstraints();

        JPasswordField pinField = new JPasswordField(14);
        JButton inquiryButton = createButton("\u7167\u4f1a\u3059\u308b");
        JLabel messageLabel = createMessageLabel();

        addFormRow(panel, constraints, 0, "\u6697\u8a3c\u756a\u53f7", pinField);
        addButtonRow(panel, constraints, 1, inquiryButton);
        addMessageRow(panel, constraints, 2, messageLabel);

        inquiryButton.addActionListener(event -> {
            if (isPinCorrect(pinField)) {
                showMessage(messageLabel, "\u73fe\u5728\u306e\u6b8b\u9ad8: " + formatAmount(balance) + "\u5186", SUCCESS_COLOR);
            } else {
                showMessage(messageLabel, "\u6697\u8a3c\u756a\u53f7\u304c\u6b63\u3057\u304f\u3042\u308a\u307e\u305b\u3093\u3002", ERROR_COLOR);
            }
            pinField.setText("");
        });
        return panel;
    }

    private JPanel createDepositPanel() {
        JPanel panel = createFormPanel();
        GridBagConstraints constraints = createConstraints();

        JTextField amountField = new JTextField(14);
        JButton depositButton = createButton("\u5165\u91d1\u3059\u308b");
        JLabel messageLabel = createMessageLabel();

        addFormRow(panel, constraints, 0, "\u5165\u91d1\u984d", amountField);
        addButtonRow(panel, constraints, 1, depositButton);
        addMessageRow(panel, constraints, 2, messageLabel);

        depositButton.addActionListener(event -> {
            BigDecimal amount = parseAmount(amountField.getText());
            if (amount == null || amount.compareTo(BigDecimal.ZERO) <= 0) {
                showMessage(messageLabel, "1\u5186\u4ee5\u4e0a\u306e\u6b63\u3057\u3044\u91d1\u984d\u3092\u5165\u529b\u3057\u3066\u304f\u3060\u3055\u3044\u3002", ERROR_COLOR);
                return;
            }

            balance = balance.add(amount);
            showMessage(messageLabel,
                    formatAmount(amount) + "\u5186\u5165\u91d1\u3057\u307e\u3057\u305f\u3002\u73fe\u5728\u306e\u6b8b\u9ad8: " + formatAmount(balance) + "\u5186", SUCCESS_COLOR);
                showReceipt("\u5165\u91d1", amount);
            amountField.setText("");
        });
        return panel;
    }

    private JPanel createWithdrawalPanel() {
        JPanel panel = createFormPanel();
        GridBagConstraints constraints = createConstraints();

        JPasswordField pinField = new JPasswordField(14);
        JTextField amountField = new JTextField(14);
        JButton withdrawalButton = createButton("\u51fa\u91d1\u3059\u308b");
        JLabel messageLabel = createMessageLabel();

        addFormRow(panel, constraints, 0, "\u6697\u8a3c\u756a\u53f7", pinField);
        addFormRow(panel, constraints, 1, "\u51fa\u91d1\u984d", amountField);
        addButtonRow(panel, constraints, 2, withdrawalButton);
        addMessageRow(panel, constraints, 3, messageLabel);

        withdrawalButton.addActionListener(event -> {
            if (!isPinCorrect(pinField)) {
                showMessage(messageLabel, "\u6697\u8a3c\u756a\u53f7\u304c\u6b63\u3057\u304f\u3042\u308a\u307e\u305b\u3093\u3002", ERROR_COLOR);
                pinField.setText("");
                return;
            }

            BigDecimal amount = parseAmount(amountField.getText());
            if (amount == null || amount.compareTo(BigDecimal.ZERO) <= 0) {
                showMessage(messageLabel, "1\u5186\u4ee5\u4e0a\u306e\u6b63\u3057\u3044\u91d1\u984d\u3092\u5165\u529b\u3057\u3066\u304f\u3060\u3055\u3044\u3002", ERROR_COLOR);
                return;
            }
            if (balance.compareTo(amount) < 0) {
                showMessage(messageLabel, "\u6b8b\u9ad8\u304c\u4e0d\u8db3\u3057\u3066\u3044\u307e\u3059\u3002\u73fe\u5728\u306e\u6b8b\u9ad8: " + formatAmount(balance) + "\u5186", ERROR_COLOR);
                return;
            }

            balance = balance.subtract(amount);
            showMessage(messageLabel,
                    formatAmount(amount) + "\u5186\u51fa\u91d1\u3057\u307e\u3057\u305f\u3002\u73fe\u5728\u306e\u6b8b\u9ad8: " + formatAmount(balance) + "\u5186", PRIMARY_COLOR);
                showReceipt("\u51fa\u91d1", amount);
            pinField.setText("");
            amountField.setText("");
        });
        return panel;
    }

    private JPanel createFormPanel() {
        JPanel panel = new JPanel(new GridBagLayout());
        panel.setBackground(Color.WHITE);
        panel.setBorder(BorderFactory.createEmptyBorder(18, 12, 10, 12));
        return panel;
    }

    private GridBagConstraints createConstraints() {
        GridBagConstraints constraints = new GridBagConstraints();
        constraints.insets = new Insets(7, 7, 7, 7);
        constraints.anchor = GridBagConstraints.CENTER;
        return constraints;
    }

    private void addFormRow(JPanel panel, GridBagConstraints constraints, int row, String labelText,
            JTextField field) {
        constraints.gridy = row;
        constraints.gridx = 0;
        constraints.weightx = 0;
        constraints.fill = GridBagConstraints.NONE;
        JLabel label = new JLabel(labelText + ":");
        label.setFont(new Font(Font.SANS_SERIF, Font.PLAIN, 14));
        panel.add(label, constraints);

        constraints.gridx = 1;
        constraints.weightx = 1;
        constraints.fill = GridBagConstraints.HORIZONTAL;
        panel.add(field, constraints);
    }

    private void addButtonRow(JPanel panel, GridBagConstraints constraints, int row, JButton button) {
        constraints.gridy = row;
        constraints.gridx = 0;
        constraints.gridwidth = 2;
        constraints.weightx = 0;
        constraints.fill = GridBagConstraints.NONE;
        panel.add(button, constraints);
        constraints.gridwidth = 1;
    }

    private void addMessageRow(JPanel panel, GridBagConstraints constraints, int row, JLabel messageLabel) {
        constraints.gridy = row;
        constraints.gridx = 0;
        constraints.gridwidth = 2;
        constraints.weightx = 1;
        constraints.fill = GridBagConstraints.HORIZONTAL;
        panel.add(messageLabel, constraints);
        constraints.gridwidth = 1;
    }

    private JButton createButton(String text) {
        JButton button = new JButton(text);
        button.setFont(new Font(Font.SANS_SERIF, Font.BOLD, 14));
        button.setForeground(Color.WHITE);
        button.setBackground(PRIMARY_COLOR);
        button.setFocusPainted(false);
        button.setBorder(BorderFactory.createEmptyBorder(8, 24, 8, 24));
        return button;
    }

    private JLabel createMessageLabel() {
        JLabel label = new JLabel(" ", SwingConstants.CENTER);
        label.setFont(new Font(Font.SANS_SERIF, Font.PLAIN, 13));
        label.setVerticalAlignment(SwingConstants.TOP);
        return label;
    }

    private boolean isPinCorrect(JPasswordField pinField) {
        return PIN.equals(new String(pinField.getPassword()));
    }

    private BigDecimal parseAmount(String text) {
        try {
            return new BigDecimal(text.trim()).setScale(2, RoundingMode.UNNECESSARY);
        } catch (ArithmeticException | NumberFormatException exception) {
            return null;
        }
    }

    private String formatAmount(BigDecimal amount) {
        return amount.setScale(2, RoundingMode.HALF_UP).toPlainString();
    }

    private void showMessage(JLabel label, String message, Color color) {
        label.setText(message);
        label.setForeground(color);
    }

    private void showReceipt(String transactionType, BigDecimal amount) {
        String receipt = "================================\n"
                + "          \u9280\u884c\u30ec\u30b7\u30fc\u30c8\n"
                + "================================\n"
                + "\u767a\u884c\u65e5\u6642: " + LocalDateTime.now().format(DateTimeFormatter.ofPattern("yyyy/MM/dd HH:mm:ss")) + "\n"
                + "\u9280\u884c\u30b3\u30fc\u30c9: " + BANK_CODE + "\n"
                + "\u652f\u5e97\u30b3\u30fc\u30c9: " + BRANCH_CODE + "\n"
                + "\u53e3\u5ea7\u756a\u53f7: " + ACCOUNT_NUMBER + "\n"
                + "\u53d6\u5f15: " + transactionType + "\n"
                + "\u53d6\u5f15\u91d1\u984d: " + formatAmount(amount) + "\u5186\n"
                + "\u53d6\u5f15\u5f8c\u6b8b\u9ad8: " + formatAmount(balance) + "\u5186\n"
                + "================================";

        JTextArea receiptArea = new JTextArea(receipt);
        receiptArea.setEditable(false);
        receiptArea.setFont(new Font(Font.MONOSPACED, Font.PLAIN, 13));
        receiptArea.setBackground(Color.WHITE);
        receiptArea.setBorder(BorderFactory.createEmptyBorder(8, 8, 8, 8));
        JOptionPane.showMessageDialog(this, receiptArea, "\u30ec\u30b7\u30fc\u30c8\u767a\u884c", JOptionPane.INFORMATION_MESSAGE);
    }

    public static void main(String[] args) {
        SwingUtilities.invokeLater(() -> {
            SimpleBankSystem bankSystem = new SimpleBankSystem();
            bankSystem.setVisible(true);
        });
    }
}