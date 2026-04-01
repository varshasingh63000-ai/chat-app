import { Component, OnInit, OnDestroy, NgZone, ChangeDetectorRef } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { HttpClient } from '@angular/common/http';
import { io, Socket } from 'socket.io-client';

interface Message {
  _id?: string;
  sender: string;
  receiver: string;
  message: string;
  timestamp: Date;
  isEdited?: boolean;
  isForwarded?: boolean;
}

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './app.component.html',
  styleUrls: ['./app.component.css']
})
export class AppComponent implements OnInit, OnDestroy {
  private socket: Socket;
  private BACKEND_URL = 'http://10.198.223.141:3000';

  username: string = '';
  selectedUser: string | null = null;
  messageInput: string = '';
  isLoggedIn: boolean = false;
  
  onlineUsers: string[] = [];
  allContacts: string[] = []; // Persistent contacts
  messages: Message[] = [];
  
  lastMessages: { [key: string]: string } = {}; // user -> last message text
  searchQuery: string = '';

  // For message actions
  editingMessage: Message | null = null;
  forwardingMessage: Message | null = null;
  showUserListModal: boolean = false;
  
  toastMessage: string | null = null;

  constructor(
    private http: HttpClient, 
    private ngZone: NgZone,
    private cdr: ChangeDetectorRef
  ) {
    this.socket = io(this.BACKEND_URL);
  }

  ngOnInit() {
    this.socket.on('newPrivateMessage', (msg: Message) => {
      this.ngZone.run(() => {
        // Update last message preview
        const otherUser = msg.sender === this.username ? msg.receiver : msg.sender;
        this.lastMessages[otherUser] = msg.message;
        
        // Add to contacts if new
        if (!this.allContacts.includes(otherUser)) {
          this.allContacts = [otherUser, ...this.allContacts];
        }

        if ((msg.sender === this.selectedUser && msg.receiver === this.username) || 
            (msg.sender === this.username && msg.receiver === this.selectedUser)) {
          this.addMessage(msg);
          this.cdr.detectChanges();
        }
      });
    });

    this.socket.on('messageUpdate', (updatedMsg: Message) => {
      console.log('Received messageUpdate:', updatedMsg);
      this.ngZone.run(() => {
        const index = this.messages.findIndex(m => m._id === updatedMsg._id);
        if (index !== -1) {
          const updatedMessages = [...this.messages];
          updatedMessages[index] = { ...updatedMsg };
          this.messages = updatedMessages;
          this.cdr.detectChanges();
        }
      });
    });

    this.socket.on('messageDelete', (messageId: string) => {
      console.log('Received messageDelete for ID:', messageId);
      this.ngZone.run(() => {
        this.messages = this.messages.filter(m => m._id !== messageId);
        this.cdr.detectChanges();
      });
    });

    this.socket.on('onlineUsers', (userList: string[]) => {
      this.ngZone.run(() => {
        this.onlineUsers = userList.filter(u => u !== this.username);
        this.cdr.detectChanges();
      });
    });
  }

  ngOnDestroy() {
    this.socket.disconnect();
  }

  login() {
    if (this.username && this.username.trim()) {
      this.username = this.username.trim();
      this.socket.emit('login', this.username);
      this.isLoggedIn = true;
      this.loadContacts();
    }
  }

  private loadContacts() {
    this.http.get<string[]>(`${this.BACKEND_URL}/api/contacts/${this.username}`).subscribe(contacts => {
      this.allContacts = contacts;
      // For each contact, we could fetch last message too if needed, 
      // but for now we'll update it as messages come or are loaded.
    });
  }

  get displayedUsers(): string[] {
    // Combine online users and all contacts, unique list
    const combined = [...new Set([...this.onlineUsers, ...this.allContacts])];
    if (!this.searchQuery.trim()) return combined;
    return combined.filter(u => u.toLowerCase().includes(this.searchQuery.toLowerCase()));
  }

  isOnline(user: string): boolean {
    return this.onlineUsers.includes(user);
  }

  sendMessage() {
    if (this.messageInput.trim() && this.username && this.selectedUser) {
      if (this.editingMessage) {
        console.log('Sending editMessage for ID:', this.editingMessage._id);
        this.socket.emit('editMessage', {
          messageId: this.editingMessage._id,
          newMessage: this.messageInput.trim()
        });
        this.editingMessage = null;
      } else {
        this.socket.emit('privateMessage', { 
          receiver: this.selectedUser, 
          message: this.messageInput.trim() 
        });
      }
      this.messageInput = '';
    }
  }

  selectUser(user: string) {
    if (this.selectedUser === user) return;
    this.selectedUser = user;
    this.loadHistory(user);
    this.markAsRead(user);
  }

  editMessage(msg: Message) {
    console.log('Edit clicked for message:', msg);
    if (msg.sender === this.username) {
      this.editingMessage = msg;
      this.messageInput = msg.message;
    }
  }

  deleteMessage(msg: Message) {
    console.log('Delete clicked for message:', msg);
    if (msg.sender === this.username && confirm('Are you sure you want to delete this message?')) {
      this.socket.emit('deleteMessage', msg._id);
    }
  }

  openForwardModal(msg: Message) {
    console.log('Forward modal opened for:', msg);
    this.forwardingMessage = msg;
    this.showUserListModal = true;
  }

  forwardMessage(user: string) {
    if (this.forwardingMessage) {
      this.socket.emit('forwardMessage', {
        receiver: user,
        message: this.forwardingMessage.message
      });
      this.showUserListModal = false;
      this.forwardingMessage = null;
      this.showToast(`Message forwarded to ${user}`);
    }
  }

  private showToast(msg: string) {
    this.toastMessage = msg;
    setTimeout(() => this.toastMessage = null, 3000);
  }

  backToSidebar() {
    this.selectedUser = null;
    this.messages = [];
  }

  cancelEdit() {
    this.editingMessage = null;
    this.messageInput = '';
  }

  private loadHistory(user: string) {
    const url = `${this.BACKEND_URL}/api/messages/${encodeURIComponent(this.username)}/${encodeURIComponent(user)}`;
    this.http.get<Message[]>(url).subscribe({
      next: (msgs) => {
        this.messages = msgs;
      },
      error: (err) => console.error('Error loading history:', err)
    });
  }

  private markAsRead(user: string) {
    const url = `${this.BACKEND_URL}/api/messages/read`;
    this.http.post(url, { sender: user, receiver: this.username }).subscribe();
  }

  private addMessage(msg: Message) {
    // Avoid duplicate messages in the array (important for sender side)
    const exists = this.messages.some(m => m._id === msg._id);
    if (!exists) {
      this.messages = [...this.messages, msg];
      setTimeout(() => {
        const div = document.getElementById('messages');
        if (div) div.scrollTop = div.scrollHeight;
      }, 100);
    }
  }

  getAvatarInitial(name: string): string {
    return name ? name.charAt(0).toUpperCase() : 'U';
  }

  trackByMsgId(index: number, msg: Message): string | undefined {
    return msg._id;
  }

  formatTime(date: Date): string {
    return new Date(date).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }
}