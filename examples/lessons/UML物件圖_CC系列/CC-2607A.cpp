// UML 物件圖教案 CC-2607A：點集合與物件計數（static 計數器改成全域變數）
// （改寫自 CF 題目 CC-2607A：運算子多載、friend、繼承與 static 改成一般成員函式，才能在瀏覽器引擎逐步執行）
#include<iostream>
#include<vector>
using namespace std;
int g_population=0;   // 原本是 Point 的 static 成員，這裡改成全域變數
class Point{
   double m_x,m_y;
public:
   Point(double x=0,double y=0):m_x(x),m_y(y){g_population++;}
   ~Point(){g_population--;}
   void addIn(const Point& b){m_x+=b.m_x;m_y+=b.m_y;}
   void divIn(double b){m_x/=b;m_y/=b;}
   void read(){cin>>m_x>>m_y;}
   void print()const{cout<<"("<<m_x<<","<<m_y<<")";}
};
class PVec{
   vector<Point> m_pts;
public:
   PVec(int n):m_pts(n){}
   void sumTo(Point& s)const{
      for(int k=0;k<m_pts.size();k++) s.addIn(m_pts[k]);
   }
   void avgTo(Point& a)const{
      sumTo(a);
      a.divIn(m_pts.size());
   }
   void read(){for(int k=0;k<m_pts.size();k++) m_pts[k].read();}
   void print()const{
      Point s;
      sumTo(s);
      cout<<"sum:";s.print();cout<<endl;
      Point a;
      avgTo(a);
      cout<<"avg:";a.print();cout<<endl;
   }
};
int main(){
   {
      int n;cin>>n;
      PVec pts(n);pts.read();
      pts.print();cout<<endl;  //@ @guide uml:pts
      cout<<g_population<<endl;
   }
   cout<<g_population<<endl;
   return 0;
}
